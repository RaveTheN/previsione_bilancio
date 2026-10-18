-- Fase 2: previsione, catena dei residui, secchi e risparmio.

-- Impostazioni del bilancio: una riga per utente.
create table public.settings (
  user_id uuid primary key default auth.uid() references auth.users on delete cascade,
  -- Primo mese del bilancio: da qui parte la catena dei residui.
  go_live_month date not null default date_trunc('month', now() at time zone 'Europe/Rome')::date
    check (extract(day from go_live_month) = 1),
  -- Residuo (disponibile sui conti spendibili) all'inizio del mese di avvio.
  opening_residual_cents bigint not null default 0,
  -- Risparmio previsto predefinito, in percentuale dello stipendio previsto.
  savings_pct numeric(5, 2) not null default 15 check (savings_pct between 0 and 100),
  -- Secchio degli accantonamenti e del risparmio predefinito.
  savings_bucket_id uuid,
  created_at timestamptz not null default now(),
  foreign key (savings_bucket_id, user_id) references public.buckets (id, user_id)
);

-- Previsione: un importo per mese, categoria e secchio (secchio vuoto per le entrate).
create table public.budget_lines (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  month date not null check (extract(day from month) = 1),
  category_id uuid not null,
  bucket_id uuid,
  -- Centesimi con segno, come i movimenti.
  amount_cents bigint not null,
  created_at timestamptz not null default now(),
  foreign key (category_id, user_id) references public.categories (id, user_id),
  foreign key (bucket_id, user_id) references public.buckets (id, user_id)
);
create unique index budget_lines_uq on public.budget_lines (user_id, month, category_id, bucket_id) nulls not distinct;

alter table public.settings enable row level security;
alter table public.budget_lines enable row level security;
create policy "solo i propri dati" on public.settings for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "solo i propri dati" on public.budget_lines for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- Vista del mese in una sola chiamata (in GET, così offline resta leggibile dalla cache):
-- - righe per categoria e secchio con previsione ed effettivo; le righe senza categoria,
--   o di uscita senza secchio, sono la parte "Da assegnare";
-- - totali di entrate, uscite e risparmio;
-- - catena dei residui dal mese di avvio: l'effettivo somma i netti reali dei mesi
--   precedenti; il previsto coincide con l'effettivo fino al mese corrente, poi prosegue
--   con i netti previsti. È una somma su tutti i mesi: nessun mese può perdere il residuo;
-- - Salvadanaio (conti riserva) a fine mese, dal saldo di riferimento e dai movimenti;
-- - percentuali dei secchi sullo stipendio (null quando non c'è stipendio).
-- p_today fissa "oggi" nei test; l'app non lo passa.
create function public.month_overview(p_month date, p_today date default null)
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
  select s.go_live_month, s.opening_residual_cents, s.savings_pct, s.savings_bucket_id,
    -- shortcut: con più categorie di risparmio vale la prima in ordine; se serviranno, sceglierla nelle impostazioni.
    (select c.id from public.categories c
      where c.kind = 'saving' and not c.archived
      order by c.sort_order, c.name limit 1) as savings_category_id
  from public.settings s
),
salary as (
  select b.month, sum(b.amount_cents) as cents
  from public.budget_lines b
  join public.categories c on c.id = b.category_id
  where c.is_salary
  group by b.month
),
-- Previsione di ogni mese: le righe scritte, più il risparmio predefinito
-- (percentuale dello stipendio previsto) dove quella riga non è stata scritta.
-- Il predefinito vale dal mese di avvio: i mesi storici restano come nel vecchio foglio.
forecast as (
  select b.month, b.category_id, b.bucket_id, b.amount_cents, false as is_default
  from public.budget_lines b
  union all
  select sa.month, st.savings_category_id, st.savings_bucket_id,
    -round(sa.cents * st.savings_pct / 100)::bigint, true
  from salary sa
  cross join st
  where sa.cents > 0
    and sa.month >= st.go_live_month
    and st.savings_category_id is not null
    and not exists (
      select from public.budget_lines b
      where b.month = sa.month
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
-- Postgres concede EXECUTE a PUBLIC con un default globale, che la revoca per schema
-- della prima migrazione non toglie: ogni funzione va revocata esplicitamente.
revoke execute on function public.month_overview(date, date) from public, anon;
grant execute on function public.month_overview(date, date) to authenticated;

-- Trasferimento tra due conti dell'utente: due righe con lo stesso gruppo, in un'unica transazione.
-- Tra spendibile e riserva è un accantonamento (o un prelievo dal Salvadanaio): il lato
-- spendibile prende la categoria di risparmio e il secchio delle impostazioni, così conta
-- una volta sola, come risparmio. Tra conti dello stesso ruolo resta fuori dai totali.
-- p_id, scelto dal client, è il gruppo: ripetere la chiamata non crea doppioni.
create function public.create_transfer(
  p_id uuid,
  p_from uuid,
  p_to uuid,
  p_amount_cents bigint,
  p_booking_date date default null,
  p_note text default null
) returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_from text := (select a.role from public.accounts a where a.id = p_from);
  v_to text := (select a.role from public.accounts a where a.id = p_to);
  v_date date := coalesce(p_booking_date, (now() at time zone 'Europe/Rome')::date);
  v_note text := nullif(trim(p_note), '');
  v_category uuid;
  v_bucket uuid;
begin
  if p_amount_cents is null or p_amount_cents <= 0 then
    raise exception 'Importo non valido' using errcode = '22023';
  end if;
  if v_from is null or v_to is null or p_from = p_to then
    raise exception 'Scegli due conti diversi' using errcode = '22023';
  end if;
  if v_from <> v_to then
    select c.id into v_category from public.categories c
    where c.kind = 'saving' and not c.archived
    order by c.sort_order, c.name limit 1;
    if v_category is null then
      raise exception 'Manca una categoria di tipo Risparmio' using errcode = '22023';
    end if;
    select s.savings_bucket_id into v_bucket from public.settings s;
  end if;
  insert into public.transactions
    (id, account_id, category_id, bucket_id, amount_cents, booking_date, note, transfer_group_id)
  values
    (md5(p_id::text || ':da')::uuid, p_from,
      case when v_from = 'spendable' then v_category end,
      case when v_from = 'spendable' then v_bucket end,
      -p_amount_cents, v_date, v_note, p_id),
    (md5(p_id::text || ':a')::uuid, p_to,
      case when v_to = 'spendable' then v_category end,
      case when v_to = 'spendable' then v_bucket end,
      p_amount_cents, v_date, v_note, p_id)
  on conflict (id) do nothing;
end
$$;
revoke execute on function public.create_transfer(uuid, uuid, uuid, bigint, date, text) from public, anon;
grant execute on function public.create_transfer(uuid, uuid, uuid, bigint, date, text) to authenticated;
