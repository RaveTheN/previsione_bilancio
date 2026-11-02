-- Import dell'estratto: niente doppioni con ciò che è già registrato. Dati finti.
begin;
create extension if not exists pgtap with schema extensions;
select plan(6);

insert into auth.users (id, email) values ('00000000-0000-0000-0000-00000000000a', 'a@example.com');
insert into public.accounts (id, user_id, name, role) values
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'BBVA', 'spendable'),
  ('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-00000000000a', 'Salvadanaio', 'reserve');
insert into public.buckets (id, user_id, name) values
  ('20000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'Future me');
insert into public.categories (id, user_id, name, kind) values
  ('30000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'Risparmio', 'saving'),
  ('30000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-00000000000a', 'Spesa', 'expense');
-- Già registrati: una notifica assegnata, un inserimento a mano, e un altro a mano uguale a un accantonamento.
insert into public.transactions (id, user_id, account_id, category_id, amount_cents, booking_date, merchant_raw, source) values
  ('60000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001',
   '30000000-0000-0000-0000-000000000002', -1200, '2026-10-16', 'BOTTEGA ESEMPIO', 'notification'),
  ('60000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001',
   null, -350, '2026-10-17', null, 'manual'),
  ('60000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001',
   null, -57, '2026-10-17', null, 'manual');

create temp table righe as select $$[
  {"id": "70000000-0000-0000-0000-000000000001", "account": "BBVA", "amount": -1200, "booking_date": "2026-10-18", "value_date": "2026-10-16", "merchant": "BOTTEGA ESEMPIO PALERMO IT", "note": "PAGAMENTO CON CARTA"},
  {"id": "70000000-0000-0000-0000-000000000002", "account": "BBVA", "amount": -1200, "booking_date": "2026-10-18", "value_date": "2026-10-17", "merchant": "BOTTEGA ESEMPIO PALERMO IT", "note": "PAGAMENTO CON CARTA"},
  {"id": "70000000-0000-0000-0000-000000000003", "account": "BBVA", "amount": -350, "booking_date": "2026-10-17", "value_date": "2026-10-17", "merchant": "EDICOLA ESEMPIO", "note": null},
  {"id": "70000000-0000-0000-0000-000000000004", "account": "BBVA", "amount": 5000, "booking_date": "2026-10-20", "value_date": "2026-10-20", "merchant": "BONIFICO RICEVUTO", "note": "Vendita"},
  {"id": "70000000-0000-0000-0000-000000000005", "account": "BBVA", "category": "Risparmio", "bucket": "Future me", "amount": -57, "booking_date": "2026-10-17", "value_date": "2026-10-17", "merchant": "PROGRAMMA", "grp": "80000000-0000-0000-0000-000000000001"},
  {"id": "70000000-0000-0000-0000-000000000006", "account": "Salvadanaio", "amount": 57, "booking_date": "2026-10-17", "value_date": "2026-10-17", "merchant": "PROGRAMMA", "grp": "80000000-0000-0000-0000-000000000001"}
]$$::jsonb as r;

select is(
  private.import_statement('00000000-0000-0000-0000-00000000000a', (select r from righe)),
  '{"nuovi": 4, "uniti_a_esistenti": 2, "gia_importati": 0}'::jsonb,
  'le righe già registrate si uniscono 1:1; la seconda riga uguale resta un movimento nuovo'
);
select is(
  (select count(*) from public.transactions where user_id = '00000000-0000-0000-0000-00000000000a'),
  7::bigint,
  'tre movimenti esistenti più quattro nuovi'
);
select results_eq(
  $$ select category_id, merchant_raw, value_date from public.transactions where id = '60000000-0000-0000-0000-000000000001' $$,
  $$ values ('30000000-0000-0000-0000-000000000002'::uuid, 'BOTTEGA ESEMPIO', '2026-10-16'::date) $$,
  'il movimento esistente tiene categoria e nome, e prende la data valuta'
);
select is(
  (select merchant_raw from public.transactions where id = '60000000-0000-0000-0000-000000000002'),
  'EDICOLA ESEMPIO',
  'l''inserimento a mano prende il nome dall''estratto'
);
select is(
  private.import_statement('00000000-0000-0000-0000-00000000000a', (select r from righe)),
  '{"nuovi": 0, "uniti_a_esistenti": 2, "gia_importati": 4}'::jsonb,
  'rieseguire l''import non cambia nulla'
);
select throws_ok(
  $$ select private.import_statement('00000000-0000-0000-0000-00000000000a',
       '[{"id": "70000000-0000-0000-0000-000000000009", "account": "Inesistente", "amount": -1, "booking_date": "2026-10-20", "value_date": "2026-10-20"}]') $$,
  'P0001', null,
  'un conto che non esiste ferma l''import'
);

select * from finish();
rollback;
