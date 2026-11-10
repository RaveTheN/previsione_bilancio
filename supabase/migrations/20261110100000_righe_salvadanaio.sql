-- Due righe che muovono il Salvadanaio, riconosciute per nome come la riga "Risparmio":
-- - "Prelievo dal Salvadanaio", tra le Entrate (senza secchio): porta soldi spendibili sul conto
--   principale e li toglie dal Salvadanaio. Conta come entrata, anche nella base delle %.
-- - "Arrotonda acquisti", in un secchio: toglie dal conto principale e mette nel Salvadanaio,
--   come il Risparmio (superare il previsto è un bene, conta nel risparmio del mese).
-- Niente dati da aggiornare: basta creare le righe con quei nomi.

-- Il lato spendibile di un movimento tra conto principale e Salvadanaio: un prelievo va sulla
-- riga "Prelievo dal Salvadanaio" se c'è nel mese, il resto (e il prelievo senza quella riga,
-- come prima) sulla riga "Risparmio".
create function public.reserve_side_line(p_user uuid, p_date date, p_withdrawal boolean)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
begin
  return coalesce(
    case when p_withdrawal then public.find_line(p_user, p_date, 'Prelievo dal Salvadanaio') end,
    public.savings_line(p_user, p_date));
end
$$;
revoke execute on function public.reserve_side_line(uuid, date, boolean) from public, anon;
grant execute on function public.reserve_side_line(uuid, date, boolean) to authenticated;

-- Uguale alla migrazione "riga_eccesso_verde", salvo: "Arrotonda acquisti" è risparmio come
-- "Risparmio", e il Salvadanaio previsto segue anche lei e "Prelievo dal Salvadanaio".
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
saving_plan as (
  select sum(b.amount_cents) as cents
  from public.budget_lines b
  cross join sel
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

-- Uguale alla migrazione "righe_libere", salvo: un prelievo dal Salvadanaio va sulla sua riga,
-- se c'è nel mese.
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
    v_line := public.reserve_side_line((select auth.uid()), v_date, v_to = 'spendable');
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

-- Uguale alla migrazione "righe_libere", salvo: una riga dell'estratto può indicare la riga
-- (campo "line", es. "Arrotonda acquisti"); senza, o se nel mese manca, vale reserve_side_line.
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
      booking_date date, value_date date, merchant text, note text, grp uuid, line text)
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
        case when r.grp is not null and r.role = 'spendable' then coalesce(
          public.find_line(p_user, r.booking_date, r.line),
          public.reserve_side_line(p_user, r.booking_date, r.amount > 0)) end,
        r.amount, (r.value_date + time '12:00') at time zone 'Europe/Rome',
        r.booking_date, r.value_date, r.merchant, r.note, 'import', r.grp);
      v_new := v_new + 1;
    end if;
  end loop;
  return jsonb_build_object('nuovi', v_new, 'uniti_a_esistenti', v_merged, 'gia_importati', v_known);
end
$$;
