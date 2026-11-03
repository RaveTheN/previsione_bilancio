-- Fase 8: i dati dei grafici in una sola chiamata. I mesi sono i month_overview del periodo, gli
-- stessi di griglia e vista mese: i numeri coincidono per costruzione. Si chiama in GET, così
-- resta leggibile offline dalla cache.
create function public.chart_data(p_from date, p_to date, p_today date default null)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
with
sel as (
  select
    date_trunc('month', p_from::timestamp)::date as first,
    date_trunc('month', p_to::timestamp)::date as last,
    coalesce(p_today, (now() at time zone 'Europe/Rome')::date) as today
),
months as (
  select m::date as month
  from sel, generate_series(sel.first::timestamp, sel.last::timestamp, interval '1 month') m
),
-- Il nome della Rubrica o, finché non ne ha uno, quello della banca. Restano fuori le operazioni
-- generiche (senza chiave), i nomi marcati "Ignora" e i mesi non ancora arrivati.
spending as (
  select coalesce(me.name, k.key) as name, t.amount_cents
  from public.transactions t
  cross join sel
  cross join lateral (select public.merchant_key(t.merchant_raw) as key) k
  left join public.merchants me on me.id = t.merchant_id
  where t.status <> 'declined'
    and t.transfer_group_id is null
    and t.month between sel.first and least(sel.last, date_trunc('month', sel.today::timestamp)::date)
    and (t.merchant_id is not null or not exists (
      select from public.merchant_aliases a
      where a.ignored
        and ((a.match_type = 'exact' and a.pattern = k.key)
          or (a.match_type = 'contains' and position(a.pattern in k.key) > 0))))
),
top_merchants as (
  select s.name, -sum(s.amount_cents)::bigint as cents
  from spending s
  where s.name is not null
  group by s.name
  having sum(s.amount_cents) < 0
  order by cents desc, s.name
  limit 10
),
rules as (
  select r.*
  from public.recurring_rules r
  join public.categories c on c.id = r.category_id
  where r.amount_cents < 0 and c.kind = 'expense'
),
-- Costo di ogni ricorrente: i movimenti collegati e, per le scadenze non ancora elaborate,
-- l'importo previsto. generated_until separa le due parti: una scadenza non conta due volte.
costs as (
  select t.recurring_rule_id as rule_id, t.month, -t.amount_cents as cents
  from public.transactions t
  join months m on m.month = t.month
  where t.recurring_rule_id is not null and t.status <> 'declined'
  union all
  select r.id, m.month, -r.amount_cents
  from rules r
  join months m on r.frequency = 'monthly' or extract(month from m.month) = extract(month from r.start_date)
  cross join lateral (select public.due_in_month(m.month, extract(day from r.start_date)::int) as due) d
  where d.due > r.generated_until and d.due >= r.start_date and (r.end_date is null or d.due <= r.end_date)
)
select jsonb_build_object(
  'months', coalesce((
    select jsonb_agg(public.month_overview(m.month, p_today) || jsonb_build_object('month', m.month) order by m.month)
    from months m), '[]'),
  'merchants', coalesce((
    select jsonb_agg(jsonb_build_object('name', t.name, 'cents', t.cents) order by t.cents desc, t.name)
    from top_merchants t), '[]'),
  'recurring', coalesce((
    select jsonb_agg(jsonb_build_object(
      'name', r.name,
      'yearly', -r.amount_cents * case when r.frequency = 'yearly' then 1 else 12 end,
      'active', r.end_date is null or r.end_date >= sel.today,
      'months', coalesce((
        select jsonb_object_agg(x.month, x.cents)
        from (select c.month, sum(c.cents)::bigint as cents from costs c where c.rule_id = r.id group by c.month) x), '{}'))
      order by -r.amount_cents * case when r.frequency = 'yearly' then 1 else 12 end desc, r.name)
    from rules r), '[]')
)
from sel
$$;
revoke execute on function public.chart_data(date, date, date) from public, anon;
grant execute on function public.chart_data(date, date, date) to authenticated;
