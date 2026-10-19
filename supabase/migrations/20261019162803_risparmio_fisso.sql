-- Risparmio previsto anche come importo fisso al mese, oltre che in percentuale dello stipendio.
-- Se l'importo è impostato vale quello; la percentuale si ricava dallo stipendio previsto.
alter table public.settings add column savings_amount_cents bigint check (savings_amount_cents >= 0);

-- Uguale alla versione della migrazione "previsioni", salvo il risparmio predefinito.
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
-- Previsione di ogni mese: le righe scritte, più il risparmio predefinito dove quella riga
-- non è stata scritta: l'importo fisso, se impostato, in ogni mese pianificato; altrimenti
-- la percentuale dello stipendio previsto. Vale dal mese di avvio: i mesi storici restano
-- come nel vecchio foglio.
forecast as (
  select b.month, b.category_id, b.bucket_id, b.amount_cents, false as is_default
  from public.budget_lines b
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
