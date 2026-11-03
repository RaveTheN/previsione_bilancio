-- La torta dei grafici: super categorie e uscite del periodo per categoria ed esercente.

-- Raggruppa le categorie di spesa. Testo libero: una nuova nasce scrivendola, in Altro.
alter table public.categories add column super_category text check (btrim(super_category) <> '');

-- La tassonomia del piano, per le categorie già presenti: docs/setup-iniziale.sql fa lo stesso sulle nuove installazioni.
update public.categories c set super_category = x.super
from (values
  ('Affitto', 'Casa'), ('Utenze', 'Casa'), ('Telefono e internet', 'Casa'), ('Garage', 'Casa'),
  ('Spesa', 'Vita quotidiana'), ('Salute', 'Vita quotidiana'), ('Cura personale', 'Vita quotidiana'), ('Contanti', 'Vita quotidiana'),
  ('Trasporti', 'Spostamenti'), ('Carburante', 'Spostamenti'), ('Moto/auto', 'Spostamenti'),
  ('Servizi digitali', 'Abbonamenti'), ('Streaming', 'Abbonamenti'),
  ('Rate e prestiti', 'Altro'), ('Uscite e ristoranti', 'Altro'), ('Acquisti', 'Altro'),
  ('Musica e strumenti', 'Altro'), ('Viaggi ed eventi', 'Altro'), ('Regali fatti', 'Altro')
) as x (name, super)
where c.name = x.name and c.kind = 'expense';

-- Uguale alla versione della migrazione "grafici", salvo le uscite per categoria ed esercente.
create or replace function public.chart_data(p_from date, p_to date, p_today date default null)
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
-- I movimenti non rifiutati fino al mese in corso, con il nome della Rubrica o, finché non ne ha
-- uno, quello della banca. Senza nome le operazioni generiche e i nomi marcati "Ignora".
named as (
  select t.category_id, t.amount_cents, t.transfer_group_id, c.kind,
    case
      when t.merchant_id is not null then me.name
      when exists (
        select from public.merchant_aliases a
        where a.ignored
          and ((a.match_type = 'exact' and a.pattern = k.key)
            or (a.match_type = 'contains' and position(a.pattern in k.key) > 0))) then null
      else k.key
    end as name
  from public.transactions t
  cross join sel
  cross join lateral (select public.merchant_key(t.merchant_raw) as key) k
  left join public.merchants me on me.id = t.merchant_id
  left join public.categories c on c.id = t.category_id
  where t.status <> 'declined'
    and t.month between sel.first and least(sel.last, date_trunc('month', sel.today::timestamp)::date)
),
top_merchants as (
  select n.name, -sum(n.amount_cents)::bigint as cents
  from named n
  where n.name is not null and n.transfer_group_id is null
  group by n.name
  having sum(n.amount_cents) < 0
  order by cents desc, n.name
  limit 10
),
-- Stessa regola di month_actuals e delle uscite di month_overview: i totali della torta coincidono con quelli del mese.
spending as (
  select n.category_id, n.name as merchant, -sum(n.amount_cents)::bigint as cents
  from named n
  where (n.transfer_group_id is null or n.category_id is not null)
    and (n.kind = 'expense' or (n.category_id is null and n.amount_cents < 0))
  group by n.category_id, n.name
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
  'spending', coalesce((
    select jsonb_agg(jsonb_build_object('category_id', s.category_id, 'merchant', s.merchant, 'cents', s.cents))
    from spending s), '[]'),
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
