-- Registro: somme dell'effettivo per riga, trasferimenti, isolamento tra utenti.
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
insert into public.budget_lines (id, user_id, month, name, bucket_id, amount_cents) values
  ('30000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', '2026-10-01', 'Spesa', '20000000-0000-0000-0000-000000000001', -20000),
  ('30000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-00000000000a', '2026-10-01', 'Risparmio', '20000000-0000-0000-0000-000000000002', -300),
  ('30000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-00000000000a', '2026-10-01', 'Stipendio', null, 150000),
  ('30000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-00000000000a', '2026-10-01', 'Luce', '20000000-0000-0000-0000-000000000001', -4000);

insert into public.transactions
  (user_id, account_id, line_id, amount_cents, booking_date, status, transfer_group_id) values
  -- spesa assegnata
  ('00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', -1000, '2026-10-05', 'confirmed', null),
  -- spesa da assegnare: conta comunque
  ('00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001', null, -500, '2026-10-06', 'confirmed', null),
  -- trasferimento ordinario: escluso
  ('00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001', null, -2000, '2026-10-07', 'confirmed', '40000000-0000-0000-0000-000000000001'),
  ('00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000002', null, 2000, '2026-10-07', 'confirmed', '40000000-0000-0000-0000-000000000001'),
  -- accantonamento: conta una volta, sulla riga Risparmio
  ('00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000002', -300, '2026-10-08', 'confirmed', '40000000-0000-0000-0000-000000000002'),
  ('00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000003', null, 300, '2026-10-08', 'confirmed', '40000000-0000-0000-0000-000000000002'),
  -- pagamento rifiutato: escluso
  ('00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', -700, '2026-10-09', 'declined', null),
  -- entrata
  ('00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000003', 150000, '2026-10-27', 'confirmed', null),
  -- entrata da assegnare
  ('00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001', null, 97000, '2026-10-13', 'confirmed', null),
  -- luce 120, i coinquilini ne rimandano 40 a testa
  ('00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000004', -12000, '2026-10-10', 'confirmed', null),
  ('00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000004', 4000, '2026-10-11', 'confirmed', null),
  ('00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000004', 4000, '2026-10-12', 'confirmed', null);

-- Da qui in poi come utente A, autenticato.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated"}', true);

select is(
  (select sum(actual_cents) from public.month_actuals where month = '2026-10-01'),
  241200::numeric,
  'netto di ottobre: esclusi trasferimenti ordinari e rifiutati'
);
select is(
  (select actual_cents from public.month_actuals where month = '2026-10-01' and line_id is null),
  96500::bigint,
  'i movimenti senza riga finiscono in "Da assegnare"'
);
select is(
  (select actual_cents from public.month_actuals where line_id = '30000000-0000-0000-0000-000000000004'),
  -4000::bigint,
  'i rimborsi sulla stessa riga la compensano: luce 120 - 80 = 40'
);
select is(
  (select actual_cents from public.month_actuals where line_id = '30000000-0000-0000-0000-000000000002'),
  -300::bigint,
  'l''accantonamento conta una sola volta, sulla riga Risparmio'
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
  $$ insert into public.transactions (account_id, line_id, amount_cents, booking_date)
     values ('10000000-0000-0000-0000-00000000000b', '30000000-0000-0000-0000-000000000001', -100, '2026-10-05') $$,
  '23503', null,
  'B non può usare una riga di A (FK composta)'
);
select throws_ok(
  $$ insert into public.transactions (user_id, account_id, amount_cents)
     values ('00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001', -100) $$,
  '42501', null,
  'B non può scrivere movimenti a nome di A (RLS)'
);

select * from finish();
rollback;
