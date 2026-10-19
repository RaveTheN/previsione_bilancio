-- I bonifici ("BONIFICO ESEGUITO", "BONIFICO RICEVUTO") non sono esercenti: ognuno è un caso a
-- sé (la parte distintiva è nella nota), quindi si assegnano uno per uno. Senza chiave non
-- entrano in Rubrica, non prendono regole e non propagano l'assegnazione.
create or replace function public.merchant_key(p_raw text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when k ~ '^BONIFICO\M' then null else k end
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

-- Pulizia di quanto già creato dai bonifici: alias, collegamento dei movimenti (categoria e
-- secchio restano) ed esercenti "Bonifico…" rimasti senza alias.
delete from public.merchant_aliases where pattern ~ '^BONIFICO\M';
update public.transactions t set merchant_id = null
from public.merchants m
where m.id = t.merchant_id and t.merchant_raw ~* '^\s*bonifico\M' and m.name ~* '^bonifico\M';
delete from public.merchants m
where m.name ~* '^bonifico\M'
  and not exists (select from public.merchant_aliases a where a.merchant_id = m.id)
  and not exists (select from public.transactions t where t.merchant_id = m.id);
