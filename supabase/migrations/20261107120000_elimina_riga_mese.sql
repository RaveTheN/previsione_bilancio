-- Elimina una riga del mese (categoria + secchio): toglie la previsione scritta e rimette
-- "da assegnare" i movimenti di quel mese, così la riga sparisce davvero. Le spese perdono
-- solo il secchio (la categoria resta, per riassegnarle con un tocco); le entrate, che non
-- hanno secchio, perdono la categoria. Restituisce quanti movimenti tornano da assegnare.
create function public.delete_month_row(p_month date, p_category_id uuid, p_bucket_id uuid)
returns int
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_count int;
begin
  delete from public.budget_lines
  where month = p_month and category_id = p_category_id and bucket_id is not distinct from p_bucket_id;

  if p_bucket_id is null then
    update public.transactions set category_id = null
    where month = p_month and category_id = p_category_id and bucket_id is null;
  else
    update public.transactions set bucket_id = null
    where month = p_month and category_id = p_category_id and bucket_id = p_bucket_id;
  end if;
  get diagnostics v_count = row_count;
  return v_count;
end
$$;
revoke execute on function public.delete_month_row(date, uuid, uuid) from public, anon;
grant execute on function public.delete_month_row(date, uuid, uuid) to authenticated;
