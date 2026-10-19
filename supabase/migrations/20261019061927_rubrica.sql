-- Fase 3b: Rubrica degli esercenti e assegnazione per esercente.

-- Nome grezzo → chiave di confronto: maiuscole, spazi uniformati, senza i prefissi
-- degli intermediari ("PAYPAL *", "SumUp *"…) e senza " CITTÀ IT" finale dell'estratto.
-- shortcut: toglie una sola parola prima di " IT" (città di due parole restano a metà); se dà fastidio, alias "contiene".
create function public.merchant_key(p_raw text)
returns text
language sql
immutable
set search_path = ''
as $$
  select nullif(
    regexp_replace(
      regexp_replace(
        upper(btrim(regexp_replace(coalesce(p_raw, ''), '\s+', ' ', 'g'))),
        '^(PAYPAL|SUMUP|SQ|ZETTLE_?|MGP) ?\* ?', ''),
      ' \S+ IT$', ''),
    '')
$$;
revoke execute on function public.merchant_key(text) from public, anon;
grant execute on function public.merchant_key(text) to authenticated;

-- Esercente con il nome scelto dall'utente e la sua regola (categoria e secchio).
create table public.merchants (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  name text not null,
  default_category_id uuid,
  default_bucket_id uuid,
  created_at timestamptz not null default now(),
  unique (id, user_id),
  foreign key (default_category_id, user_id) references public.categories (id, user_id) on delete set null (default_category_id),
  foreign key (default_bucket_id, user_id) references public.buckets (id, user_id) on delete set null (default_bucket_id)
);
create unique index merchants_name_uq on public.merchants (user_id, lower(name));

-- Nomi grezzi collegati a un esercente (chiave esatta o "contiene"), oppure da ignorare.
create table public.merchant_aliases (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  merchant_id uuid,
  match_type text not null default 'exact' check (match_type in ('exact', 'contains')),
  pattern text not null check (pattern = upper(pattern) and pattern <> ''),
  ignored boolean not null default false,
  created_at timestamptz not null default now(),
  unique (user_id, match_type, pattern),
  check (ignored or merchant_id is not null),
  foreign key (merchant_id, user_id) references public.merchants (id, user_id) on delete cascade
);

alter table public.transactions add column merchant_id uuid;
alter table public.transactions add foreign key (merchant_id, user_id)
  references public.merchants (id, user_id) on delete set null (merchant_id);

alter table public.merchants enable row level security;
alter table public.merchant_aliases enable row level security;
create policy "solo i propri dati" on public.merchants for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "solo i propri dati" on public.merchant_aliases for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- Riconosce l'esercente di un movimento che arriva con un nome grezzo (notifica, estratto,
-- unione con un inserimento manuale) e completa categoria e secchio con la sua regola,
-- senza toccare ciò che è già assegnato. Filtra sempre per utente: gira anche dentro ingest.
create function private.resolve_merchant()
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
  new.category_id := coalesce(new.category_id, v_rule.default_category_id);
  if new.bucket_id is null and new.category_id = v_rule.default_category_id then
    new.bucket_id := v_rule.default_bucket_id;
  end if;
  return new;
end
$$;
create trigger resolve_merchant before insert or update of merchant_raw on public.transactions
  for each row execute function private.resolve_merchant();

-- Rubrica "Da assegnare": nomi grezzi che nessun alias riconosce (né collegato né ignorato).
create view public.merchant_inbox with (security_invoker = true) as
select
  public.merchant_key(t.merchant_raw) as key,
  min(t.merchant_raw) as example,
  count(*)::int as n,
  max(t.booking_date) as last_date
from public.transactions t
where t.merchant_id is null
  and t.transfer_group_id is null
  and public.merchant_key(t.merchant_raw) is not null
  and not exists (
    select from public.merchant_aliases a
    where a.user_id = t.user_id
      and ((a.match_type = 'exact' and a.pattern = public.merchant_key(t.merchant_raw))
        or (a.match_type = 'contains' and position(a.pattern in public.merchant_key(t.merchant_raw)) > 0)))
group by 1;

-- Collega un nome grezzo (o un pattern "contiene") a un esercente, esistente o nuovo (per
-- nome), e completa i movimenti passati ancora senza esercente. Restituisce quanti ne collega.
create function public.link_alias(p_pattern text, p_contains boolean, p_name text)
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
    category_id = coalesce(t.category_id, v_merchant.default_category_id),
    bucket_id = case
      when t.bucket_id is null and coalesce(t.category_id, v_merchant.default_category_id) = v_merchant.default_category_id
      then v_merchant.default_bucket_id else t.bucket_id end
  where t.merchant_id is null
    and t.transfer_group_id is null
    and case when p_contains then position(v_pattern in public.merchant_key(t.merchant_raw)) > 0
             else public.merchant_key(t.merchant_raw) = v_pattern end;
  get diagnostics v_count = row_count;
  return v_count;
end
$$;
revoke execute on function public.link_alias(text, boolean, text) from public, anon;
grant execute on function public.link_alias(text, boolean, text) to authenticated;

-- Assegnazione dal movimento: categoria e secchio di questo movimento diventano la regola
-- del suo esercente (creato dal nome grezzo se manca) e completano gli altri movimenti dello
-- stesso esercente ancora da assegnare. Quelli già assegnati non si toccano.
-- Il risultato contiene i valori precedenti, per "Annulla" (undo_assign_like).
create function public.assign_like(p_transaction_id uuid)
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
revoke execute on function public.assign_like(uuid) from public, anon;
grant execute on function public.assign_like(uuid) to authenticated;

-- "Annulla" di assign_like: rimette i movimenti propagati e la regola com'erano.
-- Il movimento modificato a mano resta com'è.
create function public.undo_assign_like(p_result jsonb)
returns void
language sql
security invoker
set search_path = ''
as $$
  update public.transactions t set category_id = r.category_id, bucket_id = r.bucket_id, merchant_id = r.merchant_id
  from jsonb_to_recordset(p_result -> 'rows') as r (id uuid, category_id uuid, bucket_id uuid, merchant_id uuid)
  where t.id = r.id;
  update public.merchants set
    default_category_id = (p_result -> 'previous' ->> 'category_id')::uuid,
    default_bucket_id = (p_result -> 'previous' ->> 'bucket_id')::uuid
  where id = (p_result ->> 'merchant_id')::uuid;
$$;
revoke execute on function public.undo_assign_like(jsonb) from public, anon;
grant execute on function public.undo_assign_like(jsonb) to authenticated;
