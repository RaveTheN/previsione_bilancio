-- Fase 4: griglia annuale. Sono i 12 month_overview dell'anno, da gennaio a dicembre: i totali
-- coincidono per costruzione con quelli della vista mese, il client fa solo il pivot.
-- In GET, così la griglia resta leggibile offline dalla cache.
create function public.year_grid(p_year int, p_today date default null)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_agg(public.month_overview(make_date(p_year, n, 1), p_today) order by n)
  from generate_series(1, 12) n
$$;
revoke execute on function public.year_grid(int, date) from public, anon;
grant execute on function public.year_grid(int, date) to authenticated;
