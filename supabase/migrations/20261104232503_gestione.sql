-- Fase 9: conti e interessi, debiti e rate, wishlist, spese condivise.

-- Un solo tasso annuo: conto e Salvadanaio fanno parte dello stesso account.
-- Il secchio della wishlist è quello con cui il semaforo confronta il prezzo.
alter table public.settings
  add column interest_rate_pct numeric(5, 2) check (interest_rate_pct between 0 and 100),
  add column wishlist_bucket_id uuid,
  add foreign key (wishlist_bucket_id, user_id) references public.buckets (id, user_id);
update public.settings s set wishlist_bucket_id = b.id
from public.buckets b
where b.user_id = s.user_id and b.name = 'Fun';

-- La categoria che riceve la stima degli interessi: docs/setup-iniziale.sql fa lo stesso sulle nuove installazioni.
alter table public.categories add column is_interest boolean not null default false;
update public.categories set is_interest = true where name = 'Interessi' and kind = 'income';

-- Saldo attuale: il saldo reale dichiarato, più i movimenti registrati dopo la sua data.
-- Senza un saldo dichiarato non si calcola.
create view public.account_balances with (security_invoker = true) as
select
  a.id as account_id,
  a.balance_cents + coalesce((
    select sum(t.amount_cents) from public.transactions t
    where t.account_id = a.id
      and t.status <> 'declined'
      and t.booking_date > coalesce(a.balance_date, '-infinity')), 0)::bigint as current_cents
from public.accounts a
where not a.archived and a.balance_cents is not null;

-- Debiti: il piano delle rate è tutto ciò che serve. La scadenza è il giorno della prima rata.
create table public.debts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  name text not null check (btrim(name) <> ''),
  installment_cents bigint not null check (installment_cents > 0),
  first_due_date date not null,
  n_installments int not null check (n_installments between 1 and 1200),
  created_at timestamptz not null default now(),
  unique (id, user_id)
);
alter table public.debts enable row level security;
create policy "solo i propri dati" on public.debts for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- Rate pagate, residuo e scadenze di ogni debito. Il 31 diventa l'ultimo giorno dei mesi più corti.
-- shortcut: calcolato dal piano, quindi una rata saltata o anticipata non si vede; se succede, collegare i pagamenti reali.
create function public.debt_plan(p_today date default null)
returns table (
  id uuid, name text, installment_cents bigint, first_due_date date, n_installments int,
  paid int, remaining_cents bigint, next_due_date date, last_due_date date
)
language sql
stable
security invoker
set search_path = ''
as $$
  select d.id, d.name, d.installment_cents, d.first_due_date, d.n_installments,
    p.paid,
    d.installment_cents * (d.n_installments - p.paid),
    case when p.paid < d.n_installments
      then public.due_in_month((x.first_month + make_interval(months => p.paid))::date, x.day) end,
    public.due_in_month((x.first_month + make_interval(months => d.n_installments - 1))::date, x.day)
  from public.debts d
  cross join lateral (select coalesce(p_today, (now() at time zone 'Europe/Rome')::date) as today) t
  cross join lateral (
    select date_trunc('month', d.first_due_date::timestamp)::date as first_month,
      date_trunc('month', t.today::timestamp)::date as this_month,
      extract(day from d.first_due_date)::int as day
  ) x
  cross join lateral (
    select least(d.n_installments, greatest(0,
      (extract(year from x.this_month)::int - extract(year from x.first_month)::int) * 12
        + extract(month from x.this_month)::int - extract(month from x.first_month)::int
        + case when t.today >= public.due_in_month(x.this_month, x.day) then 1 else 0 end)) as paid
  ) p
  order by d.first_due_date, d.name
$$;
revoke execute on function public.debt_plan(date) from public, anon;
grant execute on function public.debt_plan(date) to authenticated;

-- Wishlist. "Comprato" vuol dire collegato alla spesa: se la spesa si elimina, torna da comprare.
create table public.wishlist_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  name text not null check (btrim(name) <> ''),
  price_cents bigint not null check (price_cents > 0),
  -- 1 alta, 2 media, 3 bassa.
  priority int not null default 2 check (priority between 1 and 3),
  note text,
  transaction_id uuid,
  created_at timestamptz not null default now(),
  unique (id, user_id),
  foreign key (transaction_id, user_id) references public.transactions (id, user_id) on delete set null (transaction_id)
);
alter table public.wishlist_items enable row level security;
create policy "solo i propri dati" on public.wishlist_items for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- Spese condivise: un registro di chi deve cosa a chi, fuori dal bilancio.
create table public.people (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  name text not null check (btrim(name) <> ''),
  created_at timestamptz not null default now(),
  unique (id, user_id)
);
create unique index people_name_uq on public.people (user_id, lower(name));
alter table public.people enable row level security;
create policy "solo i propri dati" on public.people for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create table public.shared_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  person_id uuid not null,
  description text not null check (btrim(description) <> ''),
  entry_date date not null default (now() at time zone 'Europe/Rome')::date,
  -- Positivo: mi deve. Negativo: gli devo.
  amount_cents bigint not null check (amount_cents <> 0),
  settled boolean not null default false,
  created_at timestamptz not null default now(),
  foreign key (person_id, user_id) references public.people (id, user_id) on delete cascade
);
alter table public.shared_entries enable row level security;
create policy "solo i propri dati" on public.shared_entries for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create view public.person_balances with (security_invoker = true) as
select p.id as person_id, coalesce(sum(e.amount_cents) filter (where not e.settled), 0)::bigint as balance_cents
from public.people p
left join public.shared_entries e on e.person_id = p.id
group by p.id;

-- Uguale alla versione della migrazione "ricorrenti", salvo la stima degli interessi nella
-- previsione e il peso delle rate sul mese.
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
  select s.go_live_month, s.opening_residual_cents, s.savings_pct, s.savings_amount_cents, s.savings_bucket_id, s.interest_rate_pct,
    -- shortcut: con più categorie di risparmio vale la prima in ordine; se serviranno, sceglierla nelle impostazioni.
    (select c.id from public.categories c
      where c.kind = 'saving' and not c.archived
      order by c.sort_order, c.name limit 1) as savings_category_id,
    (select c.id from public.categories c
      where c.is_interest and not c.archived
      order by c.sort_order, c.name limit 1) as interest_category_id
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
balances as (
  select coalesce(sum(b.current_cents), 0) as total from public.account_balances b
),
-- Previsione di ogni mese: le righe scritte; dove manca la riga, la somma delle ricorrenti, il
-- risparmio predefinito (l'importo fisso, se impostato, in ogni mese pianificato; altrimenti la
-- percentuale dello stipendio previsto) e la stima degli interessi. Vale dal mese di avvio.
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
  union all
  -- Saldo totale dei conti × tasso / 12, meno il 26% di ritenuta.
  -- shortcut: saldo e tasso di oggi per tutti i mesi, anche passati e futuri; per fissare un mese basta scrivere la riga.
  select p.month, st.interest_category_id, null::uuid,
    round(bal.total * st.interest_rate_pct / 100 / 12 * 0.74)::bigint, true
  from planned p
  cross join st
  cross join balances bal
  where st.interest_rate_pct > 0
    and bal.total > 0
    and p.month >= st.go_live_month
    and st.interest_category_id is not null
    and not exists (
      select from public.budget_lines b
      where b.month = p.month and b.category_id = st.interest_category_id and b.bucket_id is null)
    and not exists (
      select from recurring rc
      where rc.month = p.month and rc.category_id = st.interest_category_id and rc.bucket_id is null)
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
    from bucket_sums b), '[]'),
  'debt_cents', du.cents,
  'debt_pct', case when coalesce(nullif(t.salary_a, 0), t.salary_f) > 0
    then round(100.0 * du.cents / coalesce(nullif(t.salary_a, 0), t.salary_f), 1) end
)
from tot t
cross join reserve r
cross join saving_plan sp
cross join debts_due du
left join chain c on true
$$;
