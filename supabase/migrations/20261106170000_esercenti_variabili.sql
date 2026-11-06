-- Esercenti che cambiano da un acquisto all'altro (es. Amazon: a volte Fun, a volte Fundamentals).
-- Con "chiedi ogni volta" la regola non ha secchio: ogni movimento resta da assegnare finché
-- non lo scegli tu, e assegnarne uno non tocca gli altri né cambia la regola. La categoria
-- predefinita resta facoltativa.
alter table public.merchants
  add column ask_each_time boolean not null default false,
  add constraint merchants_ask_no_bucket check (not ask_each_time or default_bucket_id is null);

-- Come prima, tranne la guardia su ask_each_time dopo aver collegato l'esercente.
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
  v_rows jsonb;
begin
  select * into t from public.transactions where id = p_transaction_id;
  v_key := public.merchant_key(t.merchant_raw);
  if t.id is null or t.category_id is null or t.transfer_group_id is not null
     or (t.merchant_id is null and v_key is null) then
    return null;
  end if;

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
  update public.merchants set default_category_id = t.category_id, default_bucket_id = t.bucket_id
  where id = v_merchant.id;

  with candidates as (
    select x.id, x.category_id, x.bucket_id, x.merchant_id
    from public.transactions x
    where x.id <> t.id
      and x.transfer_group_id is null
      and x.status <> 'declined'
      and (x.category_id is null or (x.category_id = t.category_id and x.bucket_id is null and t.bucket_id is not null))
      and (x.merchant_id = v_merchant.id or (x.merchant_id is null and exists (
        select from public.merchant_aliases a
        where a.merchant_id = v_merchant.id and not a.ignored
          and ((a.match_type = 'exact' and a.pattern = public.merchant_key(x.merchant_raw))
            or (a.match_type = 'contains' and position(a.pattern in public.merchant_key(x.merchant_raw)) > 0)))))
  ), changed as (
    update public.transactions x set
      category_id = t.category_id,
      bucket_id = coalesce(x.bucket_id, t.bucket_id),
      merchant_id = v_merchant.id
    from candidates c
    where x.id = c.id
  )
  select coalesce(jsonb_agg(to_jsonb(c)), '[]') into v_rows from candidates c;

  -- Anche i movimenti già assegnati di questo nome grezzo prendono l'esercente (solo il nome).
  update public.transactions x set merchant_id = v_merchant.id
  where x.merchant_id is null and x.transfer_group_id is null and public.merchant_key(x.merchant_raw) = v_key;

  return jsonb_build_object(
    'merchant_id', v_merchant.id,
    'name', v_merchant.name,
    'previous', jsonb_build_object('category_id', v_merchant.default_category_id, 'bucket_id', v_merchant.default_bucket_id),
    'rows', v_rows);
end
$$;
