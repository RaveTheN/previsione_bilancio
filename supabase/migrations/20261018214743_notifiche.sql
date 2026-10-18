-- Fase 3a: le notifiche della banca diventano movimenti.
-- I Comandi Rapidi chiamano ingest con un token di dispositivo (ruolo anon):
-- il token può solo inserire eventi, mai leggere dati.

-- Token dei dispositivi: nel database resta solo l'hash SHA-256.
create table public.api_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  name text not null,
  token_hash text not null unique,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

-- Ultime 4 cifre di una carta → il conto che addebita.
create table public.cards (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  account_id uuid not null,
  last4 text not null check (last4 ~ '^\d{4}$'),
  created_at timestamptz not null default now(),
  unique (user_id, last4),
  foreign key (account_id, user_id) references public.accounts (id, user_id) on delete cascade
);

-- Regole per leggere le notifiche di un'app: la prima (per priorità) il cui match_regex
-- combacia estrae importo, esercente e carta, ognuno con il primo gruppo della sua regex.
create table public.parse_rules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  app text not null,
  priority int not null default 0,
  match_regex text not null,
  action text not null check (action in ('expense', 'income', 'ignore')),
  amount_regex text,
  merchant_regex text,
  card_regex text,
  created_at timestamptz not null default now()
);

-- Ogni notifica ricevuta, salvata prima di elaborarla: se l'elaborazione fallisce resta qui.
create table public.ingest_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  token_id uuid references public.api_tokens on delete set null,
  source text not null default 'notification' check (source in ('notification')),
  client_event_id text not null,
  occurred_at timestamptz not null,
  app text not null,
  -- Testi cancellati dopo 90 giorni.
  title text,
  subtitle text,
  body text,
  status text not null check (status in ('created', 'merged', 'ignored', 'unrecognized', 'error')),
  rule_id uuid references public.parse_rules on delete set null,
  transaction_id uuid,
  error text,
  created_at timestamptz not null default now(),
  unique (user_id, source, client_event_id),
  foreign key (transaction_id, user_id) references public.transactions (id, user_id) on delete set null (transaction_id)
);
create index ingest_events_user_created_idx on public.ingest_events (user_id, created_at);
create index ingest_events_transaction_idx on public.ingest_events (transaction_id);

alter table public.api_tokens enable row level security;
alter table public.cards enable row level security;
alter table public.parse_rules enable row level security;
alter table public.ingest_events enable row level security;
create policy "solo i propri dati" on public.api_tokens for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "solo i propri dati" on public.cards for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "solo i propri dati" on public.parse_rules for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "solo i propri dati" on public.ingest_events for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- Importo scritto come testo → centesimi positivi, con le stesse regole dell'app:
-- con un solo separatore è decimale se seguito da 1–2 cifre, delle migliaia se da 3.
create function private.parse_amount(p_text text)
returns bigint
language plpgsql
immutable
set search_path = ''
as $$
declare
  t text := regexp_replace(coalesce(p_text, ''), '\s|€|EUR', '', 'gi');
  comma int := strpos(reverse(t), ',');
  dot int := strpos(reverse(t), '.');
  -- Posizione dell'ultimo separatore contando dalla fine (0 = nessuno).
  sep int := case when comma = 0 then dot when dot = 0 then comma else least(comma, dot) end;
  is_decimal boolean := sep > 0 and ((comma > 0 and dot > 0) or sep - 1 <= 2);
begin
  if t !~ '^\d+([.,]\d+)*$' or (is_decimal and sep - 1 > 2) then
    return null;
  end if;
  if not is_decimal then
    return regexp_replace(t, '[.,]', '', 'g')::bigint * 100;
  end if;
  return regexp_replace(left(t, length(t) - sep), '[.,]', '', 'g')::bigint * 100
    + rpad(right(t, sep - 1), 2, '0')::int;
end
$$;

-- Trasforma un evento salvato in un movimento, oppure lo unisce a uno già presente.
-- Usata da ingest e da reprocess_event; gira come proprietario e filtra sempre per utente.
create function private.process_event(p_event_id uuid)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  e public.ingest_events;
  r public.parse_rules;
  v_text text;
  v_amount bigint;
  v_merchant text;
  v_card text;
  v_account uuid;
  v_reason text;
  v_date date;
  v_tx uuid;
  v_label text;
begin
  select * into e from public.ingest_events where id = p_event_id;
  v_text := concat_ws(E'\n', e.title, e.subtitle, e.body);

  select * into r from public.parse_rules pr
  where pr.user_id = e.user_id and lower(pr.app) = lower(e.app) and v_text ~* pr.match_regex
  order by pr.priority, pr.created_at
  limit 1;
  if not found then
    update public.ingest_events set status = 'unrecognized', rule_id = null, error = null where id = e.id;
    return jsonb_build_object('status', 'review', 'needs_review', true, 'message', 'Notifica non riconosciuta: in Da rivedere');
  end if;
  if r.action = 'ignore' then
    update public.ingest_events set status = 'ignored', rule_id = r.id, error = null where id = e.id;
    return jsonb_build_object('status', 'ignored');
  end if;

  v_amount := private.parse_amount((regexp_match(v_text, r.amount_regex, 'i'))[1]);
  v_merchant := nullif(btrim((regexp_match(v_text, r.merchant_regex, 'i'))[1]), '');
  v_card := (regexp_match(v_text, r.card_regex, 'i'))[1];
  if v_amount is null or v_amount = 0 then
    update public.ingest_events set status = 'unrecognized', rule_id = r.id, error = 'Importo non trovato' where id = e.id;
    return jsonb_build_object('status', 'review', 'needs_review', true, 'message', 'Importo non trovato: in Da rivedere');
  end if;
  if r.action = 'expense' then
    v_amount := -v_amount;
  end if;

  select c.account_id into v_account from public.cards c where c.user_id = e.user_id and c.last4 = v_card;
  -- Senza carta riconosciuta (o per notifiche senza carta, come i bonifici) vale il primo conto spendibile.
  if v_account is null then
    if r.card_regex is not null then
      v_reason := 'Carta ' || coalesce('*' || v_card, 'sconosciuta') || ' non collegata a un conto';
    end if;
    select a.id into v_account from public.accounts a
    where a.user_id = e.user_id and a.role = 'spendable' and not a.archived
    order by a.sort_order
    limit 1;
  end if;
  if v_account is null then
    raise exception 'Nessun conto spendibile';
  end if;
  if v_merchant is null then
    v_reason := coalesce(v_reason || '; ', '') || 'esercente mancante';
  end if;
  v_date := (e.occurred_at at time zone 'Europe/Rome')::date;

  -- Deduplica: stesso conto e importo, stesso periodo, e nessun evento della stessa regola
  -- già collegato (due caffè uguali restano due movimenti). Il lock serializza le richieste
  -- concorrenti sullo stesso pagamento.
  perform pg_advisory_xact_lock(hashtextextended(e.user_id::text || v_account::text || v_amount::text, 0));
  -- shortcut: con più candidati vince il più vecchio; se servirà, mandare i casi ambigui in Da rivedere.
  select t.id into v_tx from public.transactions t
  where t.user_id = e.user_id
    and t.account_id = v_account
    and t.amount_cents = v_amount
    and t.status <> 'declined'
    and t.transfer_group_id is null
    and t.booking_date between v_date - 1 and v_date + 1
    and (t.source = 'manual' or abs(extract(epoch from t.occurred_at - e.occurred_at)) <= 1800)
    and not exists (select from public.ingest_events x where x.transaction_id = t.id and x.rule_id = r.id)
  order by t.occurred_at
  limit 1;

  v_label := replace(to_char(abs(v_amount) / 100.0, 'FM999999990.00'), '.', ',') || ' €'
    || coalesce(' · ' || v_merchant, '');
  if v_tx is not null then
    update public.transactions set merchant_raw = coalesce(merchant_raw, v_merchant) where id = v_tx;
    update public.ingest_events set status = 'merged', rule_id = r.id, transaction_id = v_tx, error = null where id = e.id;
    return jsonb_build_object('status', 'merged', 'transaction_id', v_tx, 'needs_review', false,
      'message', v_label || ' · già registrato');
  end if;

  insert into public.transactions
    (user_id, account_id, amount_cents, occurred_at, booking_date, merchant_raw, source, review_reason)
  values (e.user_id, v_account, v_amount, e.occurred_at, v_date, v_merchant, 'notification', v_reason)
  returning id into v_tx;
  update public.ingest_events set status = 'created', rule_id = r.id, transaction_id = v_tx, error = null where id = e.id;
  return jsonb_build_object('status', 'created', 'transaction_id', v_tx, 'needs_review', v_reason is not null,
    'message', v_label);
end
$$;

-- Ingresso dei Comandi Rapidi. Risponde solo con l'esito: il token non legge dati.
-- Errori HTTP: 401 token non valido o revocato, 429 troppe notifiche, 400 dati non validi.
-- Le regex hanno il limite di tempo del ruolo anon (statement_timeout di 3 s) e testi di
-- al massimo 2000 caratteri.
create function public.ingest(
  token text,
  event_id text,
  occurred_at timestamptz,
  app text,
  title text default null,
  subtitle text default null,
  body text default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token public.api_tokens;
  v_text text := concat_ws(E'\n', ingest.title, ingest.subtitle, ingest.body);
  v_event_id uuid;
  v_existing public.ingest_events;
begin
  select * into v_token from public.api_tokens t
  where t.token_hash = encode(sha256(convert_to(coalesce(ingest.token, ''), 'UTF8')), 'hex')
    and t.revoked_at is null;
  if not found then
    raise exception 'invalid_token' using errcode = 'PT401';
  end if;
  if ingest.event_id is null or ingest.occurred_at is null or nullif(btrim(ingest.app), '') is null
     or length(ingest.event_id) > 100 or length(ingest.app) > 100 or length(v_text) > 2000 then
    raise exception 'invalid_payload' using errcode = 'PT400';
  end if;
  if (select count(*) from public.ingest_events e
      where e.user_id = v_token.user_id and e.created_at > now() - interval '1 hour') >= 120 then
    raise exception 'rate_limited' using errcode = 'PT429';
  end if;

  update public.api_tokens set last_used_at = now() where id = v_token.id;
  -- Privacy: i testi delle notifiche si conservano 90 giorni.
  update public.ingest_events e set title = null, subtitle = null, body = null
  where e.user_id = v_token.user_id and e.created_at < now() - interval '90 days'
    and (e.title is not null or e.subtitle is not null or e.body is not null);

  -- Codici di sicurezza e accessi: il testo non viene mai salvato.
  if v_text ~* '\m(codice|otp|password|passcode|pin|accesso|autorizza|verifica)\M' then
    return jsonb_build_object('status', 'ignored');
  end if;

  insert into public.ingest_events
    (user_id, token_id, client_event_id, occurred_at, app, title, subtitle, body, status)
  values (v_token.user_id, v_token.id, ingest.event_id, ingest.occurred_at, btrim(ingest.app),
    nullif(ingest.title, ''), nullif(ingest.subtitle, ''), nullif(ingest.body, ''), 'unrecognized')
  on conflict (user_id, source, client_event_id) do nothing
  returning id into v_event_id;
  if v_event_id is null then
    select * into v_existing from public.ingest_events e
    where e.user_id = v_token.user_id and e.source = 'notification' and e.client_event_id = ingest.event_id;
    return jsonb_build_object('status', 'duplicate', 'transaction_id', v_existing.transaction_id);
  end if;

  -- Se l'elaborazione fallisce, l'evento resta salvato con l'errore e finisce in Da rivedere.
  begin
    return private.process_event(v_event_id);
  exception when others then
    update public.ingest_events set status = 'error', error = sqlerrm where id = v_event_id;
    return jsonb_build_object('status', 'review', 'needs_review', true, 'message', 'Errore di elaborazione: in Da rivedere');
  end;
end
$$;
revoke execute on function public.ingest(text, text, timestamptz, text, text, text, text) from public, authenticated;
grant execute on function public.ingest(text, text, timestamptz, text, text, text, text) to anon;

-- "Riprova" da Da rivedere, dopo aver corretto o aggiunto una regola.
create function public.reprocess_event(p_event_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select from public.ingest_events e
    where e.id = p_event_id and e.user_id = (select auth.uid()) and e.transaction_id is null
  ) then
    raise exception 'Notifica non trovata' using errcode = '22023';
  end if;
  return private.process_event(p_event_id);
end
$$;
revoke execute on function public.reprocess_event(uuid) from public, anon;
grant execute on function public.reprocess_event(uuid) to authenticated;
