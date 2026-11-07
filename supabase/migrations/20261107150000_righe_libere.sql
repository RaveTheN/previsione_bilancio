-- Righe libere: via categorie, gruppi, ricorrenti e righe automatiche. Restano i secchi.
-- Ogni mese ha la sua lista di righe (nome, secchio o Entrate, previsto) e ogni movimento si
-- assegna a una riga del suo mese: l'effettivo è la somma con segno, quindi un rimborso sulla
-- stessa riga la compensa, come nella cella dell'Excel.

-- 1. Dati esistenti: ogni (mese, categoria, secchio) diventa una riga con il nome della categoria.
alter table public.budget_lines
  add column name text,
  add column sort_order int not null default 0;
drop index public.budget_lines_uq;

-- Le righe che esistevano solo per i movimenti, senza previsione.
insert into public.budget_lines (user_id, month, category_id, bucket_id, amount_cents)
select distinct t.user_id, t.month, t.category_id, t.bucket_id, 0::bigint
from public.transactions t
join public.categories c on c.id = t.category_id
where (t.bucket_id is not null or c.kind <> 'expense')
  and not exists (
    select from public.budget_lines b
    where b.user_id = t.user_id and b.month = t.month
      and b.category_id = t.category_id and b.bucket_id is not distinct from t.bucket_id);

-- Stessa categoria in più secchi nello stesso mese: il secchio entra nel nome.
update public.budget_lines b set
  name = x.name || case when x.n > 1 then ' (' || coalesce(x.bucket, 'Entrate') || ')' else '' end,
  sort_order = x.sort_order
from (
  select b2.id, c.name, c.sort_order, bk.name as bucket,
    count(*) over (partition by b2.user_id, b2.month, b2.category_id) as n
  from public.budget_lines b2
  join public.categories c on c.id = b2.category_id
  left join public.buckets bk on bk.id = b2.bucket_id
) x
where x.id = b.id;

alter table public.transactions add column line_id uuid;
update public.transactions t set line_id = b.id
from public.budget_lines b, public.categories c
where c.id = t.category_id
  and (t.bucket_id is not null or c.kind <> 'expense')
  and b.user_id = t.user_id and b.month = t.month
  and b.category_id = t.category_id and b.bucket_id is not distinct from t.bucket_id;

alter table public.merchants add column default_line_name text check (btrim(default_line_name) <> '');
update public.merchants m set default_line_name = c.name
from public.categories c
where c.id = m.default_category_id and not m.ask_each_time;

-- 2. Schema.
drop function public.move_month_row(date, uuid, uuid, uuid);
drop function public.delete_month_row(date, uuid, uuid);
drop view public.month_actuals;

alter table public.budget_lines
  alter column name set not null,
  add check (btrim(name) <> ''),
  drop column category_id,
  add unique (id, user_id);
create unique index budget_lines_name_uq on public.budget_lines (user_id, month, name);

-- Eliminare una riga rimette i suoi movimenti da assegnare.
alter table public.transactions
  add foreign key (line_id, user_id) references public.budget_lines (id, user_id) on delete set null (line_id),
  drop column category_id,
  drop column bucket_id,
  drop column recurring_rule_id;
create index transactions_line_idx on public.transactions (line_id);

alter table public.merchants
  drop constraint merchants_ask_no_bucket,
  drop column default_category_id,
  drop column default_bucket_id,
  add constraint merchants_ask_no_line check (not ask_each_time or default_line_name is null);

select cron.unschedule(j.jobid) from cron.job j where j.jobname = 'ricorrenti';
drop function private.run_recurring(date);
drop table public.recurring_rules;
drop table public.categories;

alter table public.settings
  drop column savings_pct,
  drop column savings_amount_cents,
  drop column interest_rate_pct;

-- 3. Copia del mese e ricerca delle righe per nome.

-- Un mese senza righe (dal mese di avvio in poi) copia quelle dell'ultimo mese che ne ha.
-- p_user serve a ingest, che gira senza utente; dall'app vale l'utente collegato, e RLS
-- impedisce comunque di leggere o scrivere le righe di altri.
-- shortcut: se elimini tutte le righe di un mese, alla prossima apertura si ricopiano; se dà fastidio, segnare i mesi già copiati.
create function public.ensure_month_lines(p_month date, p_user uuid default null)
returns int
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user uuid := coalesce(p_user, (select auth.uid()));
  v_month date := date_trunc('month', p_month::timestamp)::date;
  v_from date;
  v_n int;
begin
  if v_month < coalesce((select s.go_live_month from public.settings s where s.user_id = v_user), 'infinity')
     or exists (select from public.budget_lines b where b.user_id = v_user and b.month = v_month) then
    return 0;
  end if;
  select max(b.month) into v_from from public.budget_lines b where b.user_id = v_user and b.month < v_month;
  if v_from is null then
    return 0;
  end if;
  insert into public.budget_lines (user_id, month, name, bucket_id, amount_cents, sort_order)
  select v_user, v_month, b.name, b.bucket_id, b.amount_cents, b.sort_order
  from public.budget_lines b
  where b.user_id = v_user and b.month = v_from
  on conflict (user_id, month, name) do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end
$$;
revoke execute on function public.ensure_month_lines(date, uuid) from public, anon;
grant execute on function public.ensure_month_lines(date, uuid) to authenticated;

-- La riga con quel nome (maiuscole a parte) nel mese della data, dopo l'eventuale copia.
create function public.find_line(p_user uuid, p_date date, p_name text)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_month date := date_trunc('month', p_date::timestamp)::date;
begin
  if nullif(btrim(p_name), '') is null then
    return null;
  end if;
  perform public.ensure_month_lines(v_month, p_user);
  return (
    select b.id from public.budget_lines b
    where b.user_id = p_user and b.month = v_month and lower(b.name) = lower(btrim(p_name))
    order by b.sort_order
    limit 1);
end
$$;
revoke execute on function public.find_line(uuid, date, text) from public, anon;
grant execute on function public.find_line(uuid, date, text) to authenticated;

-- La riga "Risparmio" del mese: riceve gli accantonamenti verso il Salvadanaio. Se manca, si
-- crea nel secchio del risparmio delle impostazioni.
create function public.savings_line(p_user uuid, p_date date)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_id uuid := public.find_line(p_user, p_date, 'Risparmio');
  v_bucket uuid := (select s.savings_bucket_id from public.settings s where s.user_id = p_user);
begin
  if v_id is null then
    if v_bucket is null then
      raise exception 'Scegli il secchio del risparmio nelle Impostazioni' using errcode = '22023';
    end if;
    insert into public.budget_lines (user_id, month, name, bucket_id, amount_cents)
    values (p_user, date_trunc('month', p_date::timestamp)::date, 'Risparmio', v_bucket, 0)
    returning id into v_id;
  end if;
  return v_id;
end
$$;
revoke execute on function public.savings_line(uuid, date) from public, anon;
grant execute on function public.savings_line(uuid, date) to authenticated;

-- Un movimento resta sempre su una riga del suo mese: se cambia data, passa alla riga con lo
-- stesso nome nel nuovo mese, altrimenti torna da assegnare.
create function private.line_month()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_line public.budget_lines;
  v_date date := coalesce(new.booking_date, (now() at time zone 'Europe/Rome')::date);
begin
  if new.line_id is null then
    return new;
  end if;
  select * into v_line from public.budget_lines b where b.id = new.line_id;
  if v_line.month <> date_trunc('month', v_date::timestamp)::date then
    new.line_id := public.find_line(new.user_id, v_date, v_line.name);
  end if;
  return new;
end
$$;
create trigger line_month before insert or update of line_id, booking_date on public.transactions
  for each row execute function private.line_month();

-- 4. Funzioni riscritte sulle righe.

-- Effettivo per riga. Le righe senza riga sono "Da assegnare". I trasferimenti senza riga
-- (tra conti dello stesso ruolo, e il lato riserva degli accantonamenti) restano fuori.
create view public.month_actuals with (security_invoker = true) as
select
  user_id,
  month,
  line_id,
  sum(amount_cents)::bigint as actual_cents,
  count(*)::int as n
from public.transactions
where status <> 'declined'
  and (transfer_group_id is null or line_id is not null)
group by user_id, month, line_id;

-- Uguale alla versione della migrazione "gestione", salvo: le righe sono quelle del mese;
-- niente righe automatiche; entrate = righe senza secchio, risparmio = la riga "Risparmio"
-- (quella degli accantonamenti), uscite = le altre; la base dei secchi è il totale entrate.
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
         when lower(b.name) = 'risparmio' then 'saving'
         else 'expense' end as kind,
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
-- Risparmio previsto dal mese da cui parte la previsione fino al mese richiesto:
-- quello che il lato spendibile accantona, il Salvadanaio lo riceve.
saving_plan as (
  select sum(b.amount_cents) as cents
  from public.budget_lines b
  cross join sel
  where lower(b.name) = 'risparmio' and b.bucket_id is not null
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

-- Uguale alla versione della migrazione "torta_super_categorie", salvo: la spesa è per riga
-- (secchio e nome) ed esercente, e niente ricorrenti.
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
  select t.line_id, t.amount_cents, t.transfer_group_id,
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
-- Stessa regola di month_actuals: le righe dei secchi e le uscite da assegnare.
spending as (
  select b.bucket_id, b.name as line, n.name as merchant, -sum(n.amount_cents)::bigint as cents
  from named n
  left join public.budget_lines b on b.id = n.line_id
  where (n.transfer_group_id is null or n.line_id is not null)
    and (b.bucket_id is not null or (n.line_id is null and n.amount_cents < 0))
  group by b.bucket_id, b.name, n.name
)
select jsonb_build_object(
  'months', coalesce((
    select jsonb_agg(public.month_overview(m.month, p_today) || jsonb_build_object('month', m.month) order by m.month)
    from months m), '[]'),
  'merchants', coalesce((
    select jsonb_agg(jsonb_build_object('name', t.name, 'cents', t.cents) order by t.cents desc, t.name)
    from top_merchants t), '[]'),
  'spending', coalesce((
    select jsonb_agg(jsonb_build_object('bucket_id', s.bucket_id, 'line', s.line, 'merchant', s.merchant, 'cents', s.cents))
    from spending s), '[]')
)
from sel
$$;

-- Trasferimento tra due conti dell'utente: due righe con lo stesso gruppo, in un'unica transazione.
-- Tra spendibile e riserva è un accantonamento (o un prelievo dal Salvadanaio): il lato
-- spendibile va sulla riga "Risparmio" del mese, così conta una volta sola. Tra conti dello
-- stesso ruolo resta fuori dai totali.
-- p_id, scelto dal client, è il gruppo: ripetere la chiamata non crea doppioni.
create or replace function public.create_transfer(
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
  v_line uuid;
begin
  if p_amount_cents is null or p_amount_cents <= 0 then
    raise exception 'Importo non valido' using errcode = '22023';
  end if;
  if v_from is null or v_to is null or p_from = p_to then
    raise exception 'Scegli due conti diversi' using errcode = '22023';
  end if;
  if exists (select from public.transactions t where t.transfer_group_id = p_id) then
    return;
  end if;
  if v_from <> v_to then
    v_line := public.savings_line((select auth.uid()), v_date);
  end if;
  insert into public.transactions
    (id, account_id, line_id, amount_cents, booking_date, note, transfer_group_id)
  values
    (md5(p_id::text || ':da')::uuid, p_from, case when v_from = 'spendable' then v_line end,
      -p_amount_cents, v_date, v_note, p_id),
    (md5(p_id::text || ':a')::uuid, p_to, case when v_to = 'spendable' then v_line end,
      p_amount_cents, v_date, v_note, p_id)
  on conflict (id) do nothing;
end
$$;

-- Uguale alla versione della migrazione "rubrica", salvo: la regola dà il nome della riga,
-- cercata nel mese del movimento.
create or replace function private.resolve_merchant()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_key text := public.merchant_key(new.merchant_raw);
  v_alias public.merchant_aliases;
  v_rule public.merchants;
begin
  if new.merchant_id is not null or v_key is null or new.transfer_group_id is not null then
    return new;
  end if;
  select * into v_alias from public.merchant_aliases a
  where a.user_id = new.user_id
    and ((a.match_type = 'exact' and a.pattern = v_key)
      or (a.match_type = 'contains' and position(a.pattern in v_key) > 0))
  order by a.match_type = 'exact' desc, length(a.pattern) desc
  limit 1;
  if v_alias.id is null or v_alias.ignored then
    return new;
  end if;
  select * into v_rule from public.merchants m where m.id = v_alias.merchant_id;
  new.merchant_id := v_rule.id;
  if new.line_id is null then
    new.line_id := public.find_line(new.user_id,
      coalesce(new.booking_date, (now() at time zone 'Europe/Rome')::date), v_rule.default_line_name);
  end if;
  return new;
end
$$;

-- Uguale alla versione della migrazione "rubrica", salvo la regola per nome di riga.
create or replace function public.link_alias(p_pattern text, p_contains boolean, p_name text)
returns int
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_pattern text := upper(btrim(p_pattern));
  v_type text := case when p_contains then 'contains' else 'exact' end;
  v_merchant public.merchants;
  v_count int;
begin
  select * into v_merchant from public.merchants where lower(name) = lower(btrim(p_name));
  if not found and nullif(btrim(p_name), '') is not null then
    insert into public.merchants (name) values (btrim(p_name)) returning * into v_merchant;
  end if;
  if v_merchant.id is null or nullif(v_pattern, '') is null then
    raise exception 'Scegli un esercente e un nome' using errcode = '22023';
  end if;

  insert into public.merchant_aliases (merchant_id, match_type, pattern)
  values (v_merchant.id, v_type, v_pattern)
  on conflict (user_id, match_type, pattern) do update set merchant_id = excluded.merchant_id, ignored = false;

  update public.transactions t set
    merchant_id = v_merchant.id,
    line_id = coalesce(t.line_id, public.find_line(t.user_id, t.booking_date, v_merchant.default_line_name))
  where t.merchant_id is null
    and t.transfer_group_id is null
    and case when p_contains then position(v_pattern in public.merchant_key(t.merchant_raw)) > 0
             else public.merchant_key(t.merchant_raw) = v_pattern end;
  get diagnostics v_count = row_count;
  return v_count;
end
$$;

-- La regola di un esercente applicata ai suoi movimenti ancora da assegnare (dalla Rubrica,
-- dopo aver scelto il nome della riga). Restituisce quanti ne assegna.
create function public.apply_merchant_rule(p_merchant_id uuid)
returns int
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_merchant public.merchants;
  v_count int;
begin
  select * into v_merchant from public.merchants where id = p_merchant_id;
  if v_merchant.default_line_name is null or v_merchant.ask_each_time then
    return 0;
  end if;
  with candidates as (
    select x.id, public.find_line(x.user_id, x.booking_date, v_merchant.default_line_name) as line_id
    from public.transactions x
    where x.merchant_id = v_merchant.id and x.line_id is null
      and x.transfer_group_id is null and x.status <> 'declined'
  )
  update public.transactions x set line_id = c.line_id
  from candidates c
  where x.id = c.id and c.line_id is not null;
  get diagnostics v_count = row_count;
  return v_count;
end
$$;
revoke execute on function public.apply_merchant_rule(uuid) from public, anon;
grant execute on function public.apply_merchant_rule(uuid) to authenticated;

-- Assegnazione dal movimento: il nome della sua riga diventa la regola del suo esercente
-- (creato dal nome grezzo se manca) e assegna gli altri movimenti dello stesso esercente
-- ancora da assegnare alla riga con quel nome nel loro mese. Quelli già assegnati non si toccano.
-- Il risultato contiene i valori precedenti, per "Annulla" (undo_assign_like).
create or replace function public.assign_like(p_transaction_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  t public.transactions;
  v_key text;
  v_alias public.merchant_aliases;
  v_merchant public.merchants;
  v_name text;
  v_rows jsonb;
begin
  select * into t from public.transactions where id = p_transaction_id;
  v_key := public.merchant_key(t.merchant_raw);
  if t.id is null or t.line_id is null or t.transfer_group_id is not null
     or (t.merchant_id is null and v_key is null) then
    return null;
  end if;
  select b.name into v_name from public.budget_lines b where b.id = t.line_id;

  if t.merchant_id is not null then
    select * into v_merchant from public.merchants where id = t.merchant_id;
  else
    select * into v_alias from public.merchant_aliases a
    where (a.match_type = 'exact' and a.pattern = v_key)
       or (a.match_type = 'contains' and position(a.pattern in v_key) > 0)
    order by a.match_type = 'exact' desc, length(a.pattern) desc
    limit 1;
    if v_alias.ignored then
      return null;
    end if;
    if v_alias.id is not null then
      select * into v_merchant from public.merchants where id = v_alias.merchant_id;
    else
      -- Esercente nuovo, con il nome grezzo ripulito: si rinomina dalla Rubrica.
      select * into v_merchant from public.merchants where lower(name) = lower(v_key);
      if not found then
        insert into public.merchants (name) values (initcap(v_key)) returning * into v_merchant;
      end if;
      insert into public.merchant_aliases (merchant_id, pattern) values (v_merchant.id, v_key)
      on conflict (user_id, match_type, pattern) do nothing;
    end if;
  end if;

  update public.transactions set merchant_id = v_merchant.id where id = t.id;
  -- Esercente che varia: ogni movimento è un caso a sé, niente regola e niente propagazione.
  if v_merchant.ask_each_time then
    return null;
  end if;
  update public.merchants set default_line_name = v_name where id = v_merchant.id;

  with candidates as (
    select x.id, x.line_id, x.merchant_id, public.find_line(x.user_id, x.booking_date, v_name) as new_line
    from public.transactions x
    where x.id <> t.id
      and x.transfer_group_id is null
      and x.status <> 'declined'
      and x.line_id is null
      and (x.merchant_id = v_merchant.id or (x.merchant_id is null and exists (
        select from public.merchant_aliases a
        where a.merchant_id = v_merchant.id and not a.ignored
          and ((a.match_type = 'exact' and a.pattern = public.merchant_key(x.merchant_raw))
            or (a.match_type = 'contains' and position(a.pattern in public.merchant_key(x.merchant_raw)) > 0)))))
  ), changed as (
    update public.transactions x set line_id = c.new_line, merchant_id = v_merchant.id
    from candidates c
    where x.id = c.id and c.new_line is not null
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'line_id', c.line_id, 'merchant_id', c.merchant_id)), '[]')
  into v_rows
  from candidates c
  where c.new_line is not null;

  -- Anche i movimenti già assegnati di questo nome grezzo prendono l'esercente (solo il nome).
  update public.transactions x set merchant_id = v_merchant.id
  where x.merchant_id is null and x.transfer_group_id is null and public.merchant_key(x.merchant_raw) = v_key;

  return jsonb_build_object(
    'merchant_id', v_merchant.id,
    'name', v_merchant.name,
    'previous', jsonb_build_object('line_name', v_merchant.default_line_name),
    'rows', v_rows);
end
$$;

-- "Annulla" di assign_like: rimette i movimenti propagati e la regola com'erano.
create or replace function public.undo_assign_like(p_result jsonb)
returns void
language sql
security invoker
set search_path = ''
as $$
  update public.transactions t set line_id = r.line_id, merchant_id = r.merchant_id
  from jsonb_to_recordset(p_result -> 'rows') as r (id uuid, line_id uuid, merchant_id uuid)
  where t.id = r.id;
  update public.merchants set default_line_name = p_result -> 'previous' ->> 'line_name'
  where id = (p_result ->> 'merchant_id')::uuid;
$$;

-- Uguale alla versione della migrazione "paypal_regole", salvo: niente categoria e secchio
-- nelle righe; il lato spendibile di un accantonamento va sulla riga "Risparmio", il resto
-- lo assegnano le regole della Rubrica.
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
    select v.*, a.id as account_id, a.role
    from jsonb_to_recordset(p_rows) as v (
      id uuid, account text, amount bigint,
      booking_date date, value_date date, merchant text, note text, grp uuid)
    left join public.accounts a on a.user_id = p_user and a.name = v.account
    order by v.booking_date, v.id
  loop
    if r.account_id is null then
      raise exception 'Esegui prima docs/setup-iniziale.sql: manca il conto %', r.account;
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
        (id, user_id, account_id, line_id, amount_cents, occurred_at,
         booking_date, value_date, merchant_raw, note, source, transfer_group_id)
      values (r.id, p_user, r.account_id,
        case when r.grp is not null and r.role = 'spendable' then public.savings_line(p_user, r.booking_date) end,
        r.amount, (r.value_date + time '12:00') at time zone 'Europe/Rome',
        r.booking_date, r.value_date, r.merchant, r.note, 'import', r.grp);
      v_new := v_new + 1;
    end if;
  end loop;
  return jsonb_build_object('nuovi', v_new, 'uniti_a_esistenti', v_merged, 'gia_importati', v_known);
end
$$;
