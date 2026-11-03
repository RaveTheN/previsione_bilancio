-- Fase 6: notifiche PayPal, autorizzazioni, regole modificabili dall'app.

-- "authorized": pagamento autorizzato ma non ancora addebitato (movimento da confermare).
alter table public.parse_rules drop constraint parse_rules_action_check;
alter table public.parse_rules add constraint parse_rules_action_check
  check (action in ('expense', 'income', 'authorized', 'ignore'));
alter table public.parse_rules add check (action = 'ignore' or amount_regex is not null);
alter table public.parse_rules add check (btrim(match_regex) <> '' and btrim(app) <> '');

-- Le regole ora si scrivono dall'app: una regex non valida bloccherebbe tutte le notifiche
-- di quell'app, quindi si rifiuta al salvataggio.
create function private.check_rule_regex()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform '' ~ new.match_regex, '' ~ coalesce(new.amount_regex, ''), '' ~ coalesce(new.merchant_regex, ''), '' ~ coalesce(new.card_regex, '');
  return new;
end
$$;
create trigger check_rule_regex before insert or update on public.parse_rules
  for each row execute function private.check_rule_regex();

-- Uguale alla versione della migrazione "ricorrenti", salvo: autorizzazioni e loro addebito;
-- nell'unione vince il nome "PAYPAL *X" (quello dell'estratto, così la Rubrica riconosce
-- l'esercente in qualunque ordine arrivino le notifiche) e l'altro nome resta nella nota.
create or replace function private.process_event(p_event_id uuid)
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
  if r.action in ('expense', 'authorized') then
    v_amount := -v_amount;
  end if;

  select c.account_id into v_account from public.cards c where c.user_id = e.user_id and c.last4 = v_card;
  -- Senza carta riconosciuta (o per notifiche senza carta, come i bonifici e PayPal) vale il primo conto spendibile.
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
  v_label := replace(to_char(abs(v_amount) / 100.0, 'FM999999990.00'), '.', ',') || ' €'
    || coalesce(' · ' || v_merchant, '');

  -- Deduplica: stesso conto e importo, stesso periodo, e nessun evento della stessa regola
  -- già collegato (due caffè uguali restano due movimenti). Il lock serializza le richieste
  -- concorrenti sullo stesso pagamento.
  perform pg_advisory_xact_lock(hashtextextended(e.user_id::text || v_account::text || v_amount::text, 0));

  -- L'addebito di un pagamento autorizzato su PayPal arriva più tardi, a volte con un importo
  -- un po' diverso: si unisce all'autorizzazione e ne prende l'importo. Se l'importo non è
  -- identico serve anche il nome (i primi 6 caratteri), per non unire pagamenti diversi.
  if v_merchant ~* 'paypal' then
    select t.id into v_tx from public.transactions t
    where t.user_id = e.user_id
      and t.account_id = v_account
      and t.status = 'pending'
      and t.source = 'notification'
      and t.booking_date between v_date - 10 and v_date
      and (t.amount_cents = v_amount
        or (abs(t.amount_cents - v_amount) <= abs(t.amount_cents) * 0.2
          and left(regexp_replace(public.merchant_key(t.merchant_raw), '[^A-Z0-9]', '', 'g'), 6)
            = left(regexp_replace(public.merchant_key(v_merchant), '[^A-Z0-9]', '', 'g'), 6)))
    order by t.amount_cents = v_amount desc, t.occurred_at
    limit 1;
    if v_tx is not null then
      update public.transactions t set
        amount_cents = v_amount,
        status = 'confirmed',
        review_reason = null,
        -- Un addebito generico ("ADDEBITO PayPal…") non ha chiave: resta il nome del pagamento.
        note = coalesce(t.note, case when public.merchant_key(v_merchant) is not null then t.merchant_raw end),
        merchant_raw = case when public.merchant_key(v_merchant) is not null then v_merchant else t.merchant_raw end
      where t.id = v_tx;
      update public.ingest_events set status = 'merged', rule_id = r.id, transaction_id = v_tx, error = null where id = e.id;
      return jsonb_build_object('status', 'merged', 'transaction_id', v_tx, 'needs_review', false,
        'message', v_label || ' · addebito del pagamento autorizzato');
    end if;
  end if;

  -- shortcut: con più candidati vince il più vecchio; se servirà, mandare i casi ambigui in Da rivedere.
  select t.id into v_tx from public.transactions t
  where t.user_id = e.user_id
    and t.account_id = v_account
    and t.amount_cents = v_amount
    and t.status <> 'declined'
    and t.transfer_group_id is null
    and ((t.source = 'recurring' and t.booking_date between v_date - 3 and v_date + 3)
      or (t.booking_date between v_date - 1 and v_date + 1
        and (t.source = 'manual' or abs(extract(epoch from t.occurred_at - e.occurred_at)) <= 1800)))
    and not exists (select from public.ingest_events x where x.transaction_id = t.id and x.rule_id = r.id)
  order by t.occurred_at
  limit 1;

  if v_tx is not null then
    update public.transactions t set
      merchant_raw = case when v_merchant ~* '^PAYPAL ?\*' then v_merchant else coalesce(t.merchant_raw, v_merchant) end,
      note = coalesce(t.note, case when t.merchant_raw <> v_merchant
        then case when v_merchant ~* '^PAYPAL ?\*' then t.merchant_raw else v_merchant end end),
      status = case when t.status = 'pending' then 'confirmed' else t.status end,
      review_reason = case when t.status = 'pending' then null else t.review_reason end
    where t.id = v_tx;
    update public.ingest_events set status = 'merged', rule_id = r.id, transaction_id = v_tx, error = null where id = e.id;
    return jsonb_build_object('status', 'merged', 'transaction_id', v_tx, 'needs_review', false,
      'message', v_label || ' · già registrato');
  end if;

  if r.action = 'authorized' then
    v_reason := coalesce(v_reason || '; ', '') || 'Autorizzato: in attesa dell''addebito';
  end if;
  insert into public.transactions
    (user_id, account_id, amount_cents, occurred_at, booking_date, merchant_raw, source, status, review_reason)
  values (e.user_id, v_account, v_amount, e.occurred_at, v_date, v_merchant, 'notification',
    case when r.action = 'authorized' then 'pending' else 'confirmed' end, v_reason)
  returning id into v_tx;
  update public.ingest_events set status = 'created', rule_id = r.id, transaction_id = v_tx, error = null where id = e.id;
  return jsonb_build_object('status', 'created', 'transaction_id', v_tx, 'needs_review', v_reason is not null,
    'message', v_label);
end
$$;

-- Uguale alla versione della migrazione "notifiche", salvo il filtro: le notifiche PayPal sono
-- in inglese. Per l'inglese si cercano le frasi, perché "code" da solo sta anche nei nomi dei negozi.
create or replace function public.ingest(
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
  if v_text ~* '\m(codice|otp|password|passcode|pin|accesso|autorizza|verifica)\M|\m(security|verification|confirmation|login|one[- ]time|your)\s+code\M|\mcode\s*(is\M|:)' then
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

-- Uguale alla versione della migrazione "import_estratto", salvo: l'addebito PayPal può arrivare
-- giorni dopo il pagamento, e un'autorizzazione trovata nell'estratto diventa confermata.
create or replace function private.import_statement(p_user uuid, p_rows jsonb)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  r record;
  v_match uuid;
  v_used uuid[] := '{}';
  v_new int := 0;
  v_merged int := 0;
  v_known int := 0;
begin
  for r in
    select v.*, a.id as account_id, c.id as category_id, b.id as bucket_id
    from jsonb_to_recordset(p_rows) as v (
      id uuid, account text, category text, bucket text, amount bigint,
      booking_date date, value_date date, merchant text, note text, grp uuid)
    left join public.accounts a on a.user_id = p_user and a.name = v.account
    left join public.categories c on c.user_id = p_user and c.name = v.category
    left join public.buckets b on b.user_id = p_user and b.name = v.bucket
    order by v.booking_date, v.id
  loop
    if r.account_id is null or (r.category is not null and r.category_id is null) or (r.bucket is not null and r.bucket_id is null) then
      raise exception 'Esegui prima docs/setup-iniziale.sql: manca % / % / %', r.account, r.category, r.bucket;
    end if;
    if exists (select from public.transactions t where t.id = r.id) then
      v_known := v_known + 1;
      continue;
    end if;

    v_match := null;
    if r.grp is null then
      select t.id into v_match from public.transactions t
      where t.user_id = p_user
        and t.account_id = r.account_id
        and t.amount_cents = r.amount
        and t.source <> 'import'
        and t.status <> 'declined'
        and t.booking_date between least(r.value_date, r.booking_date) - case when r.merchant ~* 'paypal' then 10 else 3 end
                               and greatest(r.value_date, r.booking_date) + 3
        and t.id <> all (v_used)
      order by abs(t.booking_date - r.booking_date), t.occurred_at
      limit 1;
    end if;

    if v_match is not null then
      v_used := v_used || v_match;
      update public.transactions t set
        value_date = coalesce(t.value_date, r.value_date),
        merchant_raw = coalesce(t.merchant_raw, r.merchant),
        status = case when t.status = 'pending' then 'confirmed' else t.status end,
        review_reason = case when t.status = 'pending' then null else t.review_reason end
      where t.id = v_match;
      v_merged := v_merged + 1;
    else
      insert into public.transactions
        (id, user_id, account_id, category_id, bucket_id, amount_cents, occurred_at,
         booking_date, value_date, merchant_raw, note, source, transfer_group_id)
      values (r.id, p_user, r.account_id, r.category_id, r.bucket_id, r.amount,
        (r.value_date + time '12:00') at time zone 'Europe/Rome',
        r.booking_date, r.value_date, r.merchant, r.note, 'import', r.grp);
      v_new := v_new + 1;
    end if;
  end loop;
  return jsonb_build_object('nuovi', v_new, 'uniti_a_esistenti', v_merged, 'gia_importati', v_known);
end
$$;

-- Prova una regola, anche non salvata, sulle ultime notifiche ricevute da quell'app: dice quali
-- riconosce e cosa estrae. Gira come proprietario per parse_amount: filtra per utente.
create function public.test_parse(p_app text, p_match text, p_amount text, p_merchant text, p_card text)
returns table (occurred_at timestamptz, notification text, matched boolean, amount_cents bigint, merchant text, card text)
language sql
stable
security definer
set search_path = ''
as $$
  select e.occurred_at, x.txt, x.txt ~* p_match,
    case when x.txt ~* p_match then private.parse_amount((regexp_match(x.txt, p_amount, 'i'))[1]) end,
    case when x.txt ~* p_match then btrim((regexp_match(x.txt, p_merchant, 'i'))[1]) end,
    case when x.txt ~* p_match then (regexp_match(x.txt, p_card, 'i'))[1] end
  from public.ingest_events e
  cross join lateral (select concat_ws(E'\n', e.title, e.subtitle, e.body) as txt) x
  where e.user_id = (select auth.uid())
    and lower(e.app) = lower(p_app)
    and x.txt <> ''
  order by e.occurred_at desc
  limit 50
$$;
revoke execute on function public.test_parse(text, text, text, text, text) from public, anon;
grant execute on function public.test_parse(text, text, text, text, text) to authenticated;

-- "Riprova tutte" dopo aver cambiato una regola: ogni notifica fa storia a sé, un errore non ferma le altre.
create function public.reprocess_events()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_done int := 0;
  v_left int := 0;
begin
  for v_id in
    select e.id from public.ingest_events e
    where e.user_id = (select auth.uid()) and e.status in ('unrecognized', 'error') and e.transaction_id is null
    order by e.occurred_at
  loop
    begin
      if private.process_event(v_id) ->> 'status' = 'review' then
        v_left := v_left + 1;
      else
        v_done := v_done + 1;
      end if;
    exception when others then
      update public.ingest_events set status = 'error', error = sqlerrm where id = v_id;
      v_left := v_left + 1;
    end;
  end loop;
  return jsonb_build_object('riconosciute', v_done, 'ancora_da_rivedere', v_left);
end
$$;
revoke execute on function public.reprocess_events() from public, anon;
grant execute on function public.reprocess_events() to authenticated;
