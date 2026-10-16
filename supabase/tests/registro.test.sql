-- Fase 1: somme dell'effettivo, trasferimenti, isolamento tra utenti.
begin;
create extension if not exists pgtap with schema extensions;
select plan(9);

-- Due utenti: A (con dati) e B (vuoto).
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'a@example.com'),
  ('00000000-0000-0000-0000-00000000000b', 'b@example.com');

insert into public.accounts (id, user_id, name, role) values
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'Principale', 'spendable'),
  ('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-00000000000a', 'Altro conto', 'spendable'),
  ('10000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-00000000000a', 'Salvadanaio', 'reserve'),
  ('10000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-00000000000b', 'Conto B', 'spendable');
insert into public.buckets (id, user_id, name) values
  ('20000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'Fundamentals'),
  ('20000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-00000000000a', 'Future me');
insert into public.categories (id, user_id, name, kind) values
  ('30000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'Spesa', 'expense'),
  ('30000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-00000000000a', 'Risparmio', 'saving'),
  ('30000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-00000000000a', 'Stipendio', 'income');

insert into public.transactions
  (user_id, account_id, category_id, bucket_id, amount_cents, booking_date, status, transfer_group_id) values
  -- spesa classificata
  ('00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', -1000, '2026-10-05', 'confirmed', null),
  -- spesa da assegnare: conta comunque
  ('00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001', null, null, -500, '2026-10-06', 'confirmed', null),
  -- trasferimento ordinario: escluso
  ('00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001', null, null, -2000, '2026-10-07', 'confirmed', '40000000-0000-0000-0000-000000000001'),
  ('00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000002', null, null, 2000, '2026-10-07', 'confirmed', '40000000-0000-0000-0000-000000000001'),
  -- accantonamento: conta una volta, come risparmio
  ('00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000002', -300, '2026-10-08', 'confirmed', '40000000-0000-0000-0000-000000000002'),
  ('00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000003', null, null, 300, '2026-10-08', 'confirmed', '40000000-0000-0000-0000-000000000002'),
  -- pagamento rifiutato: escluso
  ('00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', -700, '2026-10-09', 'declined', null),
  -- entrata
  ('00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000003', null, 150000, '2026-10-27', 'confirmed', null),
  -- entrata da assegnare: non deve compensare la spesa da assegnare
  ('00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001', null, null, 97000, '2026-10-13', 'confirmed', null);

-- Da qui in poi come utente A, autenticato.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated"}', true);

select is(
  (select sum(actual_cents) from public.month_actuals where month = '2026-10-01'),
  245200::numeric,
  'netto di ottobre: esclusi trasferimenti ordinari e rifiutati'
);
select is(
  (select actual_cents from public.month_actuals where month = '2026-10-01' and category_id is null and not inflow),
  -500::bigint,
  'la spesa senza categoria finisce in "Da assegnare"'
);
select is(
  (select actual_cents from public.month_actuals where month = '2026-10-01' and category_id is null and inflow),
  97000::bigint,
  'entrate e uscite da assegnare restano separate'
);
select is(
  (select actual_cents from public.month_actuals
    where month = '2026-10-01' and category_id = '30000000-0000-0000-0000-000000000002'),
  -300::bigint,
  'l''accantonamento conta una sola volta, come risparmio'
);
select is(
  (select month from public.transactions where amount_cents = 150000),
  '2026-10-01'::date,
  'il mese deriva dalla data di contabilizzazione'
);

-- Utente B: non vede nulla di A e non può collegarsi ai suoi dati.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000b","role":"authenticated"}', true);

select is((select count(*) from public.transactions), 0::bigint, 'B non vede i movimenti di A');
select is((select count(*) from public.month_actuals), 0::bigint, 'B non vede l''effettivo di A');
select throws_ok(
  $$ insert into public.transactions (account_id, category_id, amount_cents)
     values ('10000000-0000-0000-0000-00000000000b', '30000000-0000-0000-0000-000000000001', -100) $$,
  '23503', null,
  'B non può usare una categoria di A (FK composta)'
);
select throws_ok(
  $$ insert into public.transactions (user_id, account_id, amount_cents)
     values ('00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001', -100) $$,
  '42501', null,
  'B non può scrivere movimenti a nome di A (RLS)'
);

select * from finish();
rollback;
