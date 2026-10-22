-- Come i bonifici, anche gli addebiti diretti di PayPal sul conto ("ADDEBITO PayPal Europe
-- S.a.r.l. et Cie S.C.A") non sono un esercente: dietro ognuno c'è un acquisto diverso.
create or replace function public.merchant_key(p_raw text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when k ~ '^(BONIFICO|ADDEBITO PAYPAL)\M' then null else k end
  from (
    select nullif(
      regexp_replace(
        regexp_replace(
          upper(btrim(regexp_replace(coalesce(p_raw, ''), '\s+', ' ', 'g'))),
          '^(PAYPAL|SUMUP|SQ|ZETTLE_?|MGP) ?\* ?', ''),
        ' \S+ IT$', ''),
      '') as k
  ) x
$$;

-- Pulizia di quanto già creato da questi addebiti (categoria e secchio dei movimenti restano).
delete from public.merchant_aliases where pattern ~ '^ADDEBITO PAYPAL\M';
update public.transactions t set merchant_id = null
from public.merchants m
where m.id = t.merchant_id and t.merchant_raw ~* '^\s*addebito paypal\M' and m.name ~* '^addebito paypal\M';
delete from public.merchants m
where m.name ~* '^addebito paypal\M'
  and not exists (select from public.merchant_aliases a where a.merchant_id = m.id)
  and not exists (select from public.transactions t where t.merchant_id = m.id);
