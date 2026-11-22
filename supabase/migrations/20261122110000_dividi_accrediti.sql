-- Un movimento si può dividere su più righe: ogni parte è un movimento a sé, con lo stesso
-- gruppo (come i trasferimenti). La somma del gruppo è l'importo visto dalla banca.
alter table public.transactions add column split_group_id uuid;

-- L'accredito di un bonifico arriva senza importo: resta in Da rivedere come entrata, e da lì
-- si crea il movimento. Prima delle altre regole BBVA: docs/setup-iniziale.sql fa lo stesso
-- sulle nuove installazioni.
--   "Accredito bonifico ✅⬅️Hai ricevuto un accredito sul tuo conto IT…"
insert into public.parse_rules (user_id, app, priority, match_regex, action)
select x.user_id, 'BBVA', x.priority - 1, 'Accredito bonifico', 'income'
from (
  select p.user_id, min(p.priority) as priority
  from public.parse_rules p
  where lower(p.app) = 'bbva'
  group by p.user_id
) x
where not exists (
  select from public.parse_rules p
  where p.user_id = x.user_id and lower(p.app) = 'bbva' and p.match_regex = 'Accredito bonifico'
);

-- Uguale alla migrazione "righe_salvadanaio", salvo: le parti di un movimento diviso non si
-- abbinano una per una (una riga dell'estratto di pari importo è un altro movimento), ma
-- insieme, quando la somma del gruppo è l'importo della riga.
create or replace function private.import_statement(p_user uuid, p_rows jsonb)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  r record;
  v_match uuid;
  v_group uuid;
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
    v_group := null;
    if r.grp is null then
      select t.id into v_match from public.transactions t
      where t.user_id = p_user
        and t.account_id = r.account_id
        and t.amount_cents = r.amount
        and t.split_group_id is null
        and t.source <> 'import'
        and t.status <> 'declined'
        and t.booking_date between least(r.value_date, r.booking_date) - case when r.merchant ~* 'paypal' then 10 else 3 end
                               and greatest(r.value_date, r.booking_date) + 3
        and t.id <> all (v_used)
      order by abs(t.booking_date - r.booking_date), t.occurred_at
      limit 1;
    end if;
    -- Un gruppo con una parte già importata è già passato dall'estratto: non si abbina di nuovo.
    if v_match is null and r.grp is null then
      select t.split_group_id into v_group from public.transactions t
      where t.user_id = p_user
        and t.account_id = r.account_id
        and t.split_group_id is not null
        and t.status <> 'declined'
        and t.booking_date between least(r.value_date, r.booking_date) - 3 and greatest(r.value_date, r.booking_date) + 3
        and t.split_group_id <> all (v_used)
      group by t.split_group_id
      having sum(t.amount_cents) = r.amount and not bool_or(t.source = 'import')
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
    elsif v_group is not null then
      v_used := v_used || v_group;
      update public.transactions t set
        value_date = coalesce(t.value_date, r.value_date),
        merchant_raw = coalesce(t.merchant_raw, r.merchant)
      where t.user_id = p_user and t.split_group_id = v_group;
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
