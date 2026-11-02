-- Fase 5: ricorrenti. Ogni regola crea un movimento il giorno della scadenza.

-- La data di partenza dà il giorno del mese e, per le annuali, anche il mese.
create table public.recurring_rules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  name text not null check (btrim(name) <> ''),
  -- Centesimi con segno, come i movimenti.
  amount_cents bigint not null check (amount_cents <> 0),
  account_id uuid not null,
  category_id uuid not null,
  bucket_id uuid,
  frequency text not null default 'monthly' check (frequency in ('monthly', 'yearly')),
  start_date date not null,
  end_date date,
  -- Data entro cui disdire, per il promemoria sul Calendario.
  cancel_by date,
  -- Scadenze elaborate fino a questo giorno: rende il job idempotente e gli fa recuperare i
  -- giorni persi. Parte da ieri: una regola nuova non genera movimenti per il passato.
  generated_until date not null default ((now() at time zone 'Europe/Rome')::date - 1),
  created_at timestamptz not null default now(),
  unique (id, user_id),
  check (end_date is null or end_date >= start_date),
  foreign key (account_id, user_id) references public.accounts (id, user_id),
  foreign key (category_id, user_id) references public.categories (id, user_id),
  foreign key (bucket_id, user_id) references public.buckets (id, user_id)
);
alter table public.recurring_rules enable row level security;
create policy "solo i propri dati" on public.recurring_rules for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

alter table public.transactions add column recurring_rule_id uuid;
alter table public.transactions add foreign key (recurring_rule_id, user_id)
  references public.recurring_rules (id, user_id) on delete set null (recurring_rule_id);

-- Giorno di scadenza nel mese che inizia in p_month: il 31 diventa l'ultimo giorno dei mesi più corti.
create function public.due_in_month(p_month date, p_day int)
returns date
language sql
immutable
set search_path = ''
as $$
  select p_month + least(p_day, extract(day from p_month + interval '1 month' - interval '1 day')::int) - 1
$$;
revoke execute on function public.due_in_month(date, int) from public, anon;
grant execute on function public.due_in_month(date, int) to authenticated;

-- Crea i movimenti delle scadenze arrivate. Se il pagamento reale è già presente (stesso conto
-- e importo, entro 3 giorni) lo collega invece di raddoppiarlo. Gira come proprietario: filtra
-- sempre per utente.
-- shortcut: importo esatto; una bolletta che varia non si unisce e resta doppia finché non si elimina una delle due; se serve, tolleranza per regola.
create function private.run_recurring(p_today date default null)
returns int
language plpgsql
set search_path = ''
as $$
declare
  v_today date := coalesce(p_today, (now() at time zone 'Europe/Rome')::date);
  r public.recurring_rules;
  v_due date;
  v_real uuid;
  v_created int := 0;
begin
  for r in select * from public.recurring_rules rr where rr.generated_until < v_today for update loop
    for v_due in
      select due from (
        select public.due_in_month(m::date, extract(day from r.start_date)::int) as due
        from generate_series(
          date_trunc('month', greatest(r.generated_until + 1, r.start_date)::timestamp),
          date_trunc('month', v_today::timestamp),
          interval '1 month') m
        where r.frequency = 'monthly' or extract(month from m) = extract(month from r.start_date)
      ) x
      where due > r.generated_until and due >= r.start_date and due <= v_today
        and (r.end_date is null or due <= r.end_date)
      order by due
    loop
      -- Stesso lock di process_event: una notifica in arrivo non può raddoppiare il movimento.
      perform pg_advisory_xact_lock(hashtextextended(r.user_id::text || r.account_id::text || r.amount_cents::text, 0));
      select t.id into v_real from public.transactions t
      where t.user_id = r.user_id
        and t.account_id = r.account_id
        and t.amount_cents = r.amount_cents
        and t.status <> 'declined'
        and t.source <> 'recurring'
        and t.recurring_rule_id is null
        and t.transfer_group_id is null
        and t.booking_date between v_due - 3 and v_due + 3
      order by abs(t.booking_date - v_due), t.occurred_at
      limit 1;
      if found then
        update public.transactions t set
          recurring_rule_id = r.id,
          note = coalesce(t.note, r.name),
          category_id = coalesce(t.category_id, r.category_id),
          bucket_id = case when t.bucket_id is null and coalesce(t.category_id, r.category_id) = r.category_id
                           then r.bucket_id else t.bucket_id end
        where t.id = v_real;
      else
        insert into public.transactions
          (user_id, account_id, category_id, bucket_id, amount_cents, occurred_at, booking_date, note, source, recurring_rule_id)
        values (r.user_id, r.account_id, r.category_id, r.bucket_id, r.amount_cents,
          (v_due + time '09:00') at time zone 'Europe/Rome', v_due, r.name, 'recurring', r.id);
        v_created := v_created + 1;
      end if;
    end loop;
    update public.recurring_rules set generated_until = v_today where id = r.id;
  end loop;
  return v_created;
end
$$;

-- Ogni notte, dopo le 3 ora italiana: la data di oggi la calcola la funzione in ora di Roma.
create extension if not exists pg_cron with schema pg_catalog;
select cron.schedule('ricorrenti', '15 2 * * *', 'select private.run_recurring()');

-- Il pagamento reale di una ricorrente si unisce a quella, entro 3 giorni dalla scadenza.
-- Uguale alla versione della migrazione "notifiche", salvo il candidato "recurring".
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
    and ((t.source = 'recurring' and t.booking_date between v_date - 3 and v_date + 3)
      or (t.booking_date between v_date - 1 and v_date + 1
        and (t.source = 'manual' or abs(extract(epoch from t.occurred_at - e.occurred_at)) <= 1800)))
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

-- Previsione predefinita di una riga: la somma delle sue ricorrenti.
-- Uguale alla versione della migrazione "risparmio_fisso", salvo le ricorrenti.
-- shortcut: una regola modificata cambia anche la previsione predefinita dei mesi passati; per fissarla basta scrivere la riga.
create or replace function public.month_overview(p_month date, p_today date default null)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
with
sel as (
  select
    date_trunc('month', p_month::timestamp)::date as month,
    date_trunc('month', coalesce(p_today, (now() at time zone 'Europe/Rome')::date)::timestamp)::date as cur
),
st as (
  select s.go_live_month, s.opening_residual_cents, s.savings_pct, s.savings_amount_cents, s.savings_bucket_id,
    -- shortcut: con più categorie di risparmio vale la prima in ordine; se serviranno, sceglierla nelle impostazioni.
    (select c.id from public.categories c
      where c.kind = 'saving' and not c.archived
      order by c.sort_order, c.name limit 1) as savings_category_id
  from public.settings s
),
-- Mesi pianificati (con almeno una riga di previsione) e il loro stipendio previsto.
planned as (
  select b.month, sum(b.amount_cents) filter (where c.is_salary) as salary
  from public.budget_lines b
  join public.categories c on c.id = b.category_id
  group by b.month
),
-- Le ricorrenti con una scadenza nel mese, per riga, dove la riga non è stata scritta.
recurring as (
  select p.month, r.category_id, r.bucket_id, sum(r.amount_cents)::bigint as cents
  from planned p
  cross join st
  join public.recurring_rules r
    on (r.frequency = 'monthly' or extract(month from p.month) = extract(month from r.start_date))
    and public.due_in_month(p.month, extract(day from r.start_date)::int) >= r.start_date
    and (r.end_date is null or public.due_in_month(p.month, extract(day from r.start_date)::int) <= r.end_date)
  where p.month >= st.go_live_month
    and not exists (
      select from public.budget_lines b
      where b.month = p.month and b.category_id = r.category_id and b.bucket_id is not distinct from r.bucket_id)
  group by p.month, r.category_id, r.bucket_id
),
-- Previsione di ogni mese: le righe scritte; dove manca la riga, la somma delle ricorrenti e
-- il risparmio predefinito: l'importo fisso, se impostato, in ogni mese pianificato; altrimenti
-- la percentuale dello stipendio previsto. Vale dal mese di avvio: i mesi storici restano
-- come nel vecchio foglio.
forecast as (
  select b.month, b.category_id, b.bucket_id, b.amount_cents, false as is_default
  from public.budget_lines b
  union all
  select rc.month, rc.category_id, rc.bucket_id, rc.cents, true
  from recurring rc
  union all
  select p.month, st.savings_category_id, st.savings_bucket_id,
    -coalesce(st.savings_amount_cents, round(p.salary * st.savings_pct / 100)::bigint), true
  from planned p
  cross join st
  where (st.savings_amount_cents is not null or p.salary > 0)
    and p.month >= st.go_live_month
    and st.savings_category_id is not null
    and not exists (
      select from public.budget_lines b
      where b.month = p.month
        and b.category_id = st.savings_category_id
        and b.bucket_id is not distinct from st.savings_bucket_id)
    and not exists (
      select from recurring rc
      where rc.month = p.month
        and rc.category_id = st.savings_category_id
        and rc.bucket_id is not distinct from st.savings_bucket_id)
),
monthly as (
  select month, sum(actual_cents) as net from public.month_actuals group by month
),
lines as (
  select x.category_id, x.bucket_id, x.inflow,
    coalesce(c.kind, case when x.inflow then 'income' else 'expense' end) as kind,
    coalesce(c.is_salary, false) as is_salary,
    sum(x.forecast)::bigint as forecast,
    coalesce(sum(x.actual), 0)::bigint as actual,
    coalesce(sum(x.n), 0)::int as n,
    coalesce(bool_or(x.is_default), false) as is_default
  from (
    select f.category_id, f.bucket_id, null::boolean as inflow,
      f.amount_cents as forecast, null::bigint as actual, null::int as n, f.is_default
    from forecast f
    join sel on f.month = sel.month
    union all
    -- Entrate e uscite senza categoria restano separate, come in month_actuals.
    select a.category_id, a.bucket_id, case when a.category_id is null then a.inflow end,
      null, a.actual_cents, a.n, null
    from public.month_actuals a
    join sel on a.month = sel.month
  ) x
  left join public.categories c on c.id = x.category_id
  group by x.category_id, x.bucket_id, x.inflow, c.kind, c.is_salary
),
tot as (
  select
    coalesce(sum(forecast) filter (where kind = 'income'), 0) as income_f,
    coalesce(sum(actual) filter (where kind = 'income'), 0) as income_a,
    coalesce(sum(forecast) filter (where kind = 'expense'), 0) as expense_f,
    coalesce(sum(actual) filter (where kind = 'expense'), 0) as expense_a,
    coalesce(sum(forecast) filter (where kind = 'saving'), 0) as saving_f,
    coalesce(sum(actual) filter (where kind = 'saving'), 0) as saving_a,
    coalesce(sum(forecast), 0) as net_f,
    coalesce(sum(actual), 0) as net_a,
    sum(forecast) filter (where is_salary) as salary_f,
    sum(actual) filter (where is_salary) as salary_a
  from lines
),
chain as (
  select
    st.opening_residual_cents + coalesce((
      select sum(m.net) from monthly m
      where m.month >= st.go_live_month and m.month < sel.month), 0) as start_a,
    st.opening_residual_cents + coalesce((
      select sum(m.net) from monthly m
      where m.month >= st.go_live_month and m.month < least(sel.month, sel.cur)), 0)
    + coalesce((
      select sum(f.amount_cents) from forecast f
      where f.month >= greatest(st.go_live_month, sel.cur) and f.month < sel.month), 0) as start_f
  from st
  cross join sel
  where sel.month >= st.go_live_month
),
reserve_acc as (
  select id, coalesce(balance_cents, 0) as ref, coalesce(balance_date, '-infinity') as rd
  from public.accounts
  where role = 'reserve'
),
-- Saldo delle riserve a fine mese (to_end) e all'inizio del mese da cui parte la previsione
-- (to_start): saldo di riferimento, più i movimenti successivi alla sua data, meno quelli
-- già compresi nel saldo ma successivi al mese richiesto.
reserve as (
  select
    sum(case when t.booking_date > r.rd and t.month <= sel.month then t.amount_cents
             when t.booking_date <= r.rd and t.month > sel.month then -t.amount_cents end) as to_end,
    sum(case when t.booking_date > r.rd and t.month < least(sel.month, sel.cur) then t.amount_cents
             when t.booking_date <= r.rd and t.month >= least(sel.month, sel.cur) then -t.amount_cents end) as to_start
  from reserve_acc r
  join public.transactions t on t.account_id = r.id and t.status <> 'declined'
  cross join sel
),
-- Risparmio previsto dal mese da cui parte la previsione fino al mese richiesto:
-- quello che il lato spendibile accantona, il Salvadanaio lo riceve.
saving_plan as (
  select sum(f.amount_cents) as cents
  from forecast f
  join public.categories c on c.id = f.category_id
  cross join sel
  where c.kind = 'saving' and f.month >= least(sel.month, sel.cur) and f.month <= sel.month
),
bucket_sums as (
  select b.id, b.sort_order, b.target_pct,
    coalesce(sum(l.forecast), 0) as f,
    coalesce(sum(l.actual), 0) as a
  from public.buckets b
  left join lines l on l.bucket_id = b.id and l.kind <> 'income'
  group by b.id, b.sort_order, b.target_pct
)
select jsonb_build_object(
  'lines', coalesce((
    select jsonb_agg(jsonb_build_object(
      'category_id', l.category_id, 'bucket_id', l.bucket_id, 'inflow', l.inflow,
      'forecast', l.forecast, 'actual', l.actual, 'n', l.n, 'is_default', l.is_default))
    from lines l), '[]'),
  'income_forecast', t.income_f, 'income_actual', t.income_a,
  'expense_forecast', t.expense_f, 'expense_actual', t.expense_a,
  'saving_forecast', t.saving_f, 'saving_actual', t.saving_a,
  'start_forecast', c.start_f, 'start_actual', c.start_a,
  'end_forecast', c.start_f + t.net_f, 'end_actual', c.start_a + t.net_a,
  'reserve_actual', case when exists (select from reserve_acc)
    then (select sum(ref) from reserve_acc) + coalesce(r.to_end, 0) end,
  'reserve_forecast', case when exists (select from reserve_acc)
    then (select sum(ref) from reserve_acc) + coalesce(r.to_start, 0) - coalesce(sp.cents, 0) end,
  -- La base è lo stipendio: previsto per la % prevista; effettivo, se c'è, per quella reale.
  'buckets', coalesce((
    select jsonb_agg(jsonb_build_object(
      'bucket_id', b.id, 'target_pct', b.target_pct,
      'forecast_pct', case when t.salary_f > 0 then round(-100 * b.f / t.salary_f, 1) end,
      'actual_pct', case when coalesce(nullif(t.salary_a, 0), t.salary_f) > 0
        then round(-100 * b.a / coalesce(nullif(t.salary_a, 0), t.salary_f), 1) end)
      order by b.sort_order)
    from bucket_sums b), '[]')
)
from tot t
cross join reserve r
cross join saving_plan sp
left join chain c on true
$$;
