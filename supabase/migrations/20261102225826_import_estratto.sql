-- L'estratto BBVA riporta il numero completo della carta nella nota degli arrotondamenti:
-- restano solo le ultime 4 cifre. D'ora in poi lo maschera anche l'importatore.
update public.transactions
set note = regexp_replace(note, '^(ARROTONDAMENTO ACQUISTI )\d{12}(\d{4})', '\1****\2')
where note ~ '^ARROTONDAMENTO ACQUISTI \d{16}';

-- Import di un estratto conto, da eseguire nello SQL Editor con il file generato da
-- tools/import/import.py. Si può rieseguire: gli id sono stabili e l'abbinamento è lo stesso.
-- Una riga dell'estratto già registrata da una notifica, a mano o da una ricorrente non crea un
-- doppione: si abbina 1:1 al movimento esistente con lo stesso conto e importo, vicino di data,
-- e lo completa senza toccare categoria e secchio. Gli accantonamenti ("grp") hanno due righe
-- proprie e non si abbinano.
create function private.import_statement(p_user uuid, p_rows jsonb)
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
    select v.*, a.id as account_id, c.id as category_id, b.id as bucket_id
    from jsonb_to_recordset(p_rows) as v (
      id uuid, account text, category text, bucket text, amount bigint,
      booking_date date, value_date date, merchant text, note text, grp uuid)
    left join public.accounts a on a.user_id = p_user and a.name = v.account
    left join public.categories c on c.user_id = p_user and c.name = v.category
    left join public.buckets b on b.user_id = p_user and b.name = v.bucket
    order by v.booking_date, v.id
  loop
    if r.account_id is null or (r.category is not null and r.category_id is null) or (r.bucket is not null and r.bucket_id is null) then
      raise exception 'Esegui prima docs/setup-iniziale.sql: manca % / % / %', r.account, r.category, r.bucket;
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
        and t.booking_date between least(r.value_date, r.booking_date) - 3 and greatest(r.value_date, r.booking_date) + 3
        and t.id <> all (v_used)
      order by abs(t.booking_date - r.booking_date), t.occurred_at
      limit 1;
    end if;

    if v_match is not null then
      v_used := v_used || v_match;
      update public.transactions t set
        value_date = coalesce(t.value_date, r.value_date),
        merchant_raw = coalesce(t.merchant_raw, r.merchant)
      where t.id = v_match;
      v_merged := v_merged + 1;
    else
      insert into public.transactions
        (id, user_id, account_id, category_id, bucket_id, amount_cents, occurred_at,
         booking_date, value_date, merchant_raw, note, source, transfer_group_id)
      values (r.id, p_user, r.account_id, r.category_id, r.bucket_id, r.amount,
        (r.value_date + time '12:00') at time zone 'Europe/Rome',
        r.booking_date, r.value_date, r.merchant, r.note, 'import', r.grp);
      v_new := v_new + 1;
    end if;
  end loop;
  return jsonb_build_object('nuovi', v_new, 'uniti_a_esistenti', v_merged, 'gia_importati', v_known);
end
$$;
