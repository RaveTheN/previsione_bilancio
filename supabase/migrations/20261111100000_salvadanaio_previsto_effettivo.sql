-- Salvadanaio previsto: ogni riga che lo muove (Risparmio, Arrotonda acquisti, Prelievo dal
-- Salvadanaio) conta con il suo effettivo se ha dei movimenti, altrimenti con il previsto.
-- Uguale alla migrazione "righe_salvadanaio", salvo la CTE saving_plan.
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
  select s.go_live_month, s.opening_residual_cents from public.settings s
),
monthly as (
  select month, sum(actual_cents) as net from public.month_actuals group by month
),
lines as (
  select b.id, b.name, b.bucket_id, b.sort_order,
    case when b.bucket_id is null then 'income'
         when lower(b.name) in ('risparmio', 'arrotonda acquisti') then 'saving'
         else 'expense' end as kind,
    b.over_is_good or (b.bucket_id is not null and lower(b.name) in ('risparmio', 'arrotonda acquisti')) as over_is_good,
    b.amount_cents as forecast,
    coalesce(a.actual_cents, 0)::bigint as actual,
    coalesce(a.n, 0)::int as n
  from public.budget_lines b
  join sel on b.month = sel.month
  left join public.month_actuals a on a.line_id = b.id
),
unassigned as (
  select coalesce(sum(a.actual_cents), 0)::bigint as actual, coalesce(sum(a.n), 0)::int as n
  from public.month_actuals a
  join sel on a.month = sel.month
  where a.line_id is null
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
    coalesce(sum(actual), 0) + (select u.actual from unassigned u) as net_a
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
      select sum(b.amount_cents) from public.budget_lines b
      where b.month >= greatest(st.go_live_month, sel.cur) and b.month < sel.month), 0) as start_f
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
-- Le righe che muovono il Salvadanaio, dal mese da cui parte la previsione fino al mese
-- richiesto: quello che il lato spendibile accantona (Risparmio, Arrotonda acquisti, negative)
-- il Salvadanaio lo riceve; quello che preleva (Prelievo dal Salvadanaio, positiva) lo perde.
-- Con dei movimenti conta l'effettivo: i movimenti del Salvadanaio nel mese non sono in to_start.
saving_plan as (
  select sum(case when coalesce(a.n, 0) > 0 then a.actual_cents else b.amount_cents end) as cents
  from public.budget_lines b
  cross join sel
  left join public.month_actuals a on a.line_id = b.id
  where ((b.bucket_id is not null and lower(b.name) in ('risparmio', 'arrotonda acquisti'))
      or (b.bucket_id is null and lower(b.name) = 'prelievo dal salvadanaio'))
    and b.month >= least(sel.month, sel.cur) and b.month <= sel.month
),
bucket_sums as (
  select b.id, b.sort_order, b.target_pct,
    coalesce(sum(l.forecast), 0) as f,
    coalesce(sum(l.actual), 0) as a
  from public.buckets b
  left join lines l on l.bucket_id = b.id
  group by b.id, b.sort_order, b.target_pct
),
-- Le rate che cadono nel mese, dal piano dei debiti.
debts_due as (
  select coalesce(sum(d.installment_cents), 0)::bigint as cents
  from public.debts d
  cross join sel
  where sel.month >= date_trunc('month', d.first_due_date::timestamp)::date
    and sel.month < date_trunc('month', d.first_due_date::timestamp)::date + make_interval(months => d.n_installments)
)
select jsonb_build_object(
  'lines', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', l.id, 'name', l.name, 'bucket_id', l.bucket_id, 'sort_order', l.sort_order,
      'over_is_good', l.over_is_good,
      'forecast', l.forecast, 'actual', l.actual, 'n', l.n)
      order by l.sort_order, l.name)
    from lines l), '[]'),
  'unassigned', (select jsonb_build_object('actual', u.actual, 'n', u.n) from unassigned u),
  'income_forecast', t.income_f, 'income_actual', t.income_a,
  'expense_forecast', t.expense_f, 'expense_actual', t.expense_a,
  'saving_forecast', t.saving_f, 'saving_actual', t.saving_a,
  'start_forecast', c.start_f, 'start_actual', c.start_a,
  'end_forecast', c.start_f + t.net_f, 'end_actual', c.start_a + t.net_a,
  'reserve_actual', case when exists (select from reserve_acc)
    then (select sum(ref) from reserve_acc) + coalesce(r.to_end, 0) end,
  'reserve_forecast', case when exists (select from reserve_acc)
    then (select sum(ref) from reserve_acc) + coalesce(r.to_start, 0) - coalesce(sp.cents, 0) end,
  -- La base sono le entrate: previste per la % prevista; effettive, se ci sono, per quella reale.
  'buckets', coalesce((
    select jsonb_agg(jsonb_build_object(
      'bucket_id', b.id, 'target_pct', b.target_pct,
      'forecast_pct', case when t.income_f > 0 then round(-100 * b.f / t.income_f, 1) end,
      'actual_pct', case when coalesce(nullif(t.income_a, 0), t.income_f) > 0
        then round(-100 * b.a / coalesce(nullif(t.income_a, 0), t.income_f), 1) end)
      order by b.sort_order)
    from bucket_sums b), '[]'),
  'debt_cents', du.cents,
  'debt_pct', case when coalesce(nullif(t.income_a, 0), t.income_f) > 0
    then round(100.0 * du.cents / coalesce(nullif(t.income_a, 0), t.income_f), 1) end
)
from tot t
cross join reserve r
cross join saving_plan sp
cross join debts_due du
left join chain c on true
$$;
