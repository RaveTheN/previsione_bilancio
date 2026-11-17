-- Le regole delle notifiche parlano con le righe del mese:
-- - line_name: il movimento creato va sulla riga con quel nome (es. un prelievo su "Contanti");
-- - azione "forecast": nessun movimento, ma una riga tra le Entrate con il previsto uguale
--   all'importo (es. un rimborso accettato): l'effettivo si scrive quando arrivano i soldi;
-- - spesa o entrata senza regex dell'importo: la notifica non dice la cifra (es. "Arrotonda
--   acquisti"), resta in Da rivedere e l'importo si scrive lì (complete_event).

alter table public.parse_rules add column line_name text check (btrim(line_name) <> '');
alter table public.parse_rules drop constraint parse_rules_action_check;
alter table public.parse_rules add constraint parse_rules_action_check
  check (action in ('expense', 'income', 'authorized', 'forecast', 'ignore'));

-- Il vincolo "senza importo solo se si ignora" era senza nome: si cerca per definizione.
do $$
declare
  v_name text;
begin
  for v_name in
    select c.conname from pg_catalog.pg_constraint c
    where c.conrelid = 'public.parse_rules'::regclass and c.contype = 'c'
      and pg_catalog.pg_get_constraintdef(c.oid) ilike '%amount_regex IS NOT NULL%'
  loop
    execute format('alter table public.parse_rules drop constraint %I', v_name);
  end loop;
end
$$;
alter table public.parse_rules add constraint parse_rules_amount_check
  check (action in ('ignore', 'expense', 'income') or amount_regex is not null);

-- Uguale alla versione della migrazione "paypal_regole", salvo: importo da chiedere, azione
-- "forecast" e riga della regola (anche sui movimenti uniti, se non ne hanno già una).
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
  v_line uuid;
  v_name text;
  v_n int;
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
  if r.amount_regex is null then
    update public.ingest_events set status = 'unrecognized', rule_id = r.id, error = 'Importo da inserire' where id = e.id;
    return jsonb_build_object('status', 'review', 'needs_review', true, 'message', 'Importo da inserire: in Da rivedere');
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
  v_date := (e.occurred_at at time zone 'Europe/Rome')::date;
  v_label := replace(to_char(abs(v_amount) / 100.0, 'FM999999990.00'), '.', ',') || ' €'
    || coalesce(' · ' || v_merchant, '');

  if r.action = 'forecast' then
    v_name := btrim(coalesce(r.line_name, 'Rimborso') || ' ' || coalesce(v_merchant, ''));
    perform public.ensure_month_lines(v_date, e.user_id);
    -- shortcut: una riga delle Entrate con lo stesso previsto (o lo stesso nome) nel mese vale
    -- come già creata, anche se è un altro rimborso di pari importo; se capita, crearla a mano.
    insert into public.budget_lines (user_id, month, name, bucket_id, amount_cents, sort_order)
    select e.user_id, date_trunc('month', v_date::timestamp)::date, v_name, null, v_amount,
      coalesce((select max(b.sort_order) + 1 from public.budget_lines b
        where b.user_id = e.user_id and b.month = date_trunc('month', v_date::timestamp)::date), 0)
    where not exists (
      select from public.budget_lines b
      where b.user_id = e.user_id and b.month = date_trunc('month', v_date::timestamp)::date
        and b.bucket_id is null and (b.amount_cents = v_amount or lower(b.name) = lower(v_name)))
    on conflict (user_id, month, name) do nothing;
    get diagnostics v_n = row_count;
    update public.ingest_events set status = case when v_n > 0 then 'created' else 'merged' end,
      rule_id = r.id, error = null where id = e.id;
    return jsonb_build_object('status', case when v_n > 0 then 'created' else 'merged' end, 'needs_review', false,
      'message', v_label || case when v_n > 0 then ' · riga "' || v_name || '" con il previsto' else ' · riga già presente' end);
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
  v_line := public.find_line(e.user_id, v_date, r.line_name);
  -- Con la riga della regola l'esercente non serve (es. un prelievo).
  if v_merchant is null and v_line is null then
    v_reason := coalesce(v_reason || '; ', '') || 'esercente mancante';
  end if;

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
        line_id = coalesce(t.line_id, v_line),
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
      line_id = coalesce(t.line_id, v_line),
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
    (user_id, account_id, line_id, amount_cents, occurred_at, booking_date, merchant_raw, source, status, review_reason)
  values (e.user_id, v_account, v_line, v_amount, e.occurred_at, v_date, v_merchant, 'notification',
    case when r.action = 'authorized' then 'pending' else 'confirmed' end, v_reason)
  returning id into v_tx;
  update public.ingest_events set status = 'created', rule_id = r.id, transaction_id = v_tx, error = null where id = e.id;
  return jsonb_build_object('status', 'created', 'transaction_id', v_tx, 'needs_review', v_reason is not null,
    'message', v_label);
end
$$;

-- L'importo scritto in Da rivedere per una notifica che non lo contiene: crea il movimento
-- sul primo conto spendibile, sulla riga della regola, nel giorno della notifica.
create function public.complete_event(p_event_id uuid, p_amount_cents bigint)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  e public.ingest_events;
  r public.parse_rules;
  v_account uuid;
  v_date date;
  v_tx uuid;
begin
  select * into e from public.ingest_events where id = p_event_id and transaction_id is null;
  select * into r from public.parse_rules where id = e.rule_id;
  if r.id is null or r.amount_regex is not null or r.action not in ('expense', 'income') then
    raise exception 'Questa notifica non aspetta un importo' using errcode = '22023';
  end if;
  if p_amount_cents is null or p_amount_cents <= 0 then
    raise exception 'Importo non valido' using errcode = '22023';
  end if;
  select a.id into v_account from public.accounts a
  where a.role = 'spendable' and not a.archived
  order by a.sort_order
  limit 1;
  if v_account is null then
    raise exception 'Nessun conto spendibile' using errcode = '22023';
  end if;
  v_date := (e.occurred_at at time zone 'Europe/Rome')::date;
  insert into public.transactions
    (user_id, account_id, line_id, amount_cents, occurred_at, booking_date, note, source)
  values (e.user_id, v_account, public.find_line(e.user_id, v_date, r.line_name),
    case when r.action = 'expense' then -p_amount_cents else p_amount_cents end,
    e.occurred_at, v_date, nullif(btrim(e.title), ''), 'notification')
  returning id into v_tx;
  update public.ingest_events set status = 'created', transaction_id = v_tx, error = null where id = e.id;
  return v_tx;
end
$$;
revoke execute on function public.complete_event(uuid, bigint) from public, anon;
grant execute on function public.complete_event(uuid, bigint) to authenticated;
