-- Quarto secchio "Altro", dopo gli altri e senza obiettivo: docs/setup-iniziale.sql fa lo stesso sulle nuove installazioni.
insert into public.buckets (user_id, name, sort_order, target_pct)
select u.id, 'Altro', 4, 0
from auth.users u
on conflict do nothing;
