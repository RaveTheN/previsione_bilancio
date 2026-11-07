-- Sposta una riga del mese (categoria + secchio) in un altro secchio: la previsione scritta
-- (sommata a quella già presente nel secchio di arrivo) e i movimenti di quel mese, insieme.
create function public.move_month_row(p_month date, p_category_id uuid, p_from uuid, p_to uuid)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_amount bigint;
begin
  if p_from is null or p_to is null or p_from = p_to then
    raise exception 'Scegli un secchio diverso' using errcode = '22023';
  end if;

  delete from public.budget_lines
  where month = p_month and category_id = p_category_id and bucket_id = p_from
  returning amount_cents into v_amount;
  if v_amount is not null then
    insert into public.budget_lines (month, category_id, bucket_id, amount_cents)
    values (p_month, p_category_id, p_to, v_amount)
    on conflict (user_id, month, category_id, bucket_id)
    do update set amount_cents = public.budget_lines.amount_cents + excluded.amount_cents;
  end if;

  update public.transactions set bucket_id = p_to
  where month = p_month and category_id = p_category_id and bucket_id = p_from;
end
$$;
revoke execute on function public.move_month_row(date, uuid, uuid, uuid) from public, anon;
grant execute on function public.move_month_row(date, uuid, uuid, uuid) to authenticated;
