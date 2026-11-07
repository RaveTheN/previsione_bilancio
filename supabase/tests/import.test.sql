-- Import dell'estratto: niente doppioni con ciò che è già registrato. Dati finti.
begin;
create extension if not exists pgtap with schema extensions;
select plan(9);

insert into auth.users (id, email) values ('00000000-0000-0000-0000-00000000000a', 'a@example.com');
insert into public.accounts (id, user_id, name, role) values
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'BBVA', 'spendable'),
  ('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-00000000000a', 'Salvadanaio', 'reserve');
insert into public.buckets (id, user_id, name) values
  ('20000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'Future me');
insert into public.settings (user_id, go_live_month, savings_bucket_id) values
  ('00000000-0000-0000-0000-00000000000a', '2026-10-01', '20000000-0000-0000-0000-000000000001');
insert into public.budget_lines (id, user_id, month, name, bucket_id, amount_cents) values
  ('30000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-00000000000a', '2026-10-01', 'Spesa', '20000000-0000-0000-0000-000000000001', 0);
-- Già registrati: una notifica assegnata, un inserimento a mano, e un altro a mano uguale a un accantonamento.
insert into public.transactions (id, user_id, account_id, line_id, amount_cents, booking_date, merchant_raw, source) values
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
  {"id": "70000000-0000-0000-0000-000000000005", "account": "BBVA", "amount": -57, "booking_date": "2026-10-17", "value_date": "2026-10-17", "merchant": "PROGRAMMA", "grp": "80000000-0000-0000-0000-000000000001"},
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
  $$ select line_id, merchant_raw, value_date from public.transactions where id = '60000000-0000-0000-0000-000000000001' $$,
  $$ values ('30000000-0000-0000-0000-000000000002'::uuid, 'BOTTEGA ESEMPIO', '2026-10-16'::date) $$,
  'il movimento esistente tiene riga e nome, e prende la data valuta'
);
select results_eq(
  $$ select t.account_id, b.name from public.transactions t left join public.budget_lines b on b.id = t.line_id
     where t.transfer_group_id = '80000000-0000-0000-0000-000000000001' order by t.amount_cents $$,
  $$ values ('10000000-0000-0000-0000-000000000001'::uuid, 'Risparmio'), ('10000000-0000-0000-0000-000000000002'::uuid, null) $$,
  'accantonamento: il lato spendibile va sulla riga Risparmio (creata se manca), il Salvadanaio no'
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
-- Un'autorizzazione PayPal addebitata giorni dopo come "ADDEBITO PayPal": si unisce e si conferma.
insert into public.transactions (id, user_id, account_id, amount_cents, booking_date, merchant_raw, source, status, review_reason) values
  ('60000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001',
   -1940, '2026-10-20', 'CONSEGNE ESEMPIO SL', 'notification', 'pending', 'Autorizzato: in attesa dell''addebito');
select is(
  private.import_statement('00000000-0000-0000-0000-00000000000a',
    '[{"id": "70000000-0000-0000-0000-000000000007", "account": "BBVA", "amount": -1940, "booking_date": "2026-10-28", "value_date": "2026-10-27", "merchant": "ADDEBITO PayPal Europe S.a.r.l. et Cie S.C.A"}]'),
  '{"nuovi": 0, "uniti_a_esistenti": 1, "gia_importati": 0}'::jsonb,
  'addebito PayPal una settimana dopo: unito all''autorizzazione'
);
select results_eq(
  $$ select status, review_reason, merchant_raw from public.transactions where id = '60000000-0000-0000-0000-000000000004' $$,
  $$ values ('confirmed', null::text, 'CONSEGNE ESEMPIO SL') $$,
  'l''autorizzazione diventa confermata e tiene il nome del pagamento'
);
select throws_ok(
  $$ select private.import_statement('00000000-0000-0000-0000-00000000000a',
       '[{"id": "70000000-0000-0000-0000-000000000009", "account": "Inesistente", "amount": -1, "booking_date": "2026-10-20", "value_date": "2026-10-20"}]') $$,
  'P0001', null,
  'un conto che non esiste ferma l''import'
);

select * from finish();
rollback;
