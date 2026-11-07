-- Fase 9: saldo attuale, rimborsi, debiti, wishlist, spese condivise. Dati finti.
begin;
create extension if not exists pgtap with schema extensions;
select plan(22);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'a@example.com'),
  ('00000000-0000-0000-0000-00000000000b', 'b@example.com');
insert into public.accounts (id, user_id, name, role, balance_cents, balance_date, archived) values
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'Banca', 'spendable', 100000, '2026-10-01', false),
  ('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-00000000000a', 'Salvadanaio', 'reserve', 200000, '2026-10-01', false),
  ('10000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-00000000000a', 'Chiuso', 'spendable', 999900, '2026-10-01', true),
  ('10000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-00000000000a', 'Senza saldo', 'spendable', null, null, false),
  ('10000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-00000000000b', 'Banca di B', 'spendable', 5000, '2026-10-01', false);
insert into public.buckets (id, user_id, name) values
  ('20000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'Fun');
insert into public.settings (user_id, go_live_month, opening_residual_cents) values
  ('00000000-0000-0000-0000-00000000000a', '2026-09-01', 0);
insert into public.budget_lines (id, user_id, month, name, bucket_id, amount_cents) values
  ('30000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', '2026-11-01', 'Stipendio', null, 200000),
  ('30000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-00000000000a', '2026-12-01', 'Stipendio', null, 200000),
  ('30000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-00000000000a', '2026-08-01', 'Spesa', '20000000-0000-0000-0000-000000000001', 0);
insert into public.transactions (id, user_id, account_id, amount_cents, booking_date, status) values
  -- Il giorno del saldo è già compreso nel saldo.
  ('60000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001', -5000, '2026-10-01', 'confirmed'),
  ('60000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001', -10000, '2026-10-15', 'confirmed'),
  ('60000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001', -7777, '2026-10-16', 'declined'),
  ('60000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000002', 5000, '2026-10-20', 'confirmed'),
  ('60000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-00000000000b', '10000000-0000-0000-0000-000000000005', -100, '2026-10-20', 'confirmed');
insert into public.debts (id, user_id, name, installment_cents, first_due_date, n_installments) values
  -- Il 31: dieci rate, l'ultima il 31 ottobre.
  ('70000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'Telefono', 5000, '2026-01-31', 10),
  ('70000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-00000000000a', 'Moto', 10000, '2026-09-05', 12),
  ('70000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-00000000000a', 'Futuro', 1000, '2027-01-10', 3);
insert into public.people (id, user_id, name) values
  ('80000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'Persona uno'),
  ('80000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-00000000000a', 'Persona due'),
  ('80000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-00000000000a', 'Persona tre');
insert into public.shared_entries (user_id, person_id, description, amount_cents, settled) values
  -- "ha pagato internet": gliene devo una parte; "deve pagare internet": me ne deve una parte.
  ('00000000-0000-0000-0000-00000000000a', '80000000-0000-0000-0000-000000000001', 'Ha pagato internet', -2000, false),
  ('00000000-0000-0000-0000-00000000000a', '80000000-0000-0000-0000-000000000001', 'Spesa di casa', 500, false),
  ('00000000-0000-0000-0000-00000000000a', '80000000-0000-0000-0000-000000000001', 'Già saldata', -9000, true),
  ('00000000-0000-0000-0000-00000000000a', '80000000-0000-0000-0000-000000000002', 'Deve pagare internet', 2000, false);

set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}', true);

-- Saldo attuale
select bag_eq(
  $$ select account_id::text as conto, current_cents as saldo from public.account_balances $$,
  $$ values
       ('10000000-0000-0000-0000-000000000001', 90000::bigint),
       ('10000000-0000-0000-0000-000000000002', 205000::bigint) $$,
  'saldo attuale: saldo reale più i movimenti dopo la sua data; fuori rifiutati, conti archiviati e conti senza saldo'
);

-- Un rimborso su una riga di spesa si sottrae dalle uscite, senza gonfiare le entrate.
insert into public.transactions (account_id, line_id, amount_cents, booking_date) values
  ('10000000-0000-0000-0000-000000000004', '30000000-0000-0000-0000-000000000003', -11631, '2026-08-05'),
  ('10000000-0000-0000-0000-000000000004', '30000000-0000-0000-0000-000000000003', 3877, '2026-08-07');
select results_eq(
  $$ select (public.month_overview('2026-08-01', '2026-11-15') ->> 'expense_actual')::bigint,
            (public.month_overview('2026-08-01', '2026-11-15') ->> 'income_actual')::bigint $$,
  $$ values (-7754::bigint, 0::bigint) $$,
  'un rimborso sulla riga di spesa riduce le uscite e non conta come entrata'
);

-- Debiti
select results_eq(
  $$ select paid, remaining_cents, next_due_date, last_due_date from public.debt_plan('2026-02-27') where name = 'Telefono' $$,
  $$ values (1, 45000::bigint, '2026-02-28'::date, '2026-10-31'::date) $$,
  'il giorno prima della scadenza la rata non è pagata; il 31 diventa il 28'
);
select results_eq(
  $$ select paid, next_due_date from public.debt_plan('2026-02-28') where name = 'Telefono' $$,
  $$ values (2, '2026-03-31'::date) $$,
  'il giorno della scadenza la rata conta come pagata'
);
select results_eq(
  $$ select paid, remaining_cents, next_due_date from public.debt_plan('2027-05-01') where name = 'Telefono' $$,
  $$ values (10, 0::bigint, null::date) $$,
  'finito il piano: tutto pagato, nessun residuo né prossima scadenza'
);
select results_eq(
  $$ select paid, remaining_cents, next_due_date, last_due_date from public.debt_plan('2026-11-15') where name = 'Futuro' $$,
  $$ values (0, 3000::bigint, '2027-01-10'::date, '2027-03-10'::date) $$,
  'prima della prima rata: nulla pagato, residuo intero'
);
select results_eq(
  $$ select (public.month_overview('2026-11-01', '2026-11-15') ->> 'debt_cents')::bigint,
            (public.month_overview('2026-11-01', '2026-11-15') ->> 'debt_pct')::numeric $$,
  $$ values (10000::bigint, 5.0::numeric) $$,
  'peso sul mese: le rate che cadono nel mese, sulle entrate; il Telefono è finito a ottobre'
);
select results_eq(
  $$ select (public.month_overview('2026-10-01', '2026-11-15') ->> 'debt_cents')::bigint,
            public.month_overview('2026-10-01', '2026-11-15') ->> 'debt_pct' $$,
  $$ values (15000::bigint, null::text) $$,
  'l''ultima rata conta; un mese senza entrate non ha percentuale'
);
select is((public.month_overview('2027-04-01', '2026-11-15') ->> 'debt_cents')::bigint, 10000::bigint, 'la Moto continua l''anno dopo, Futuro è finito a marzo');
select throws_ok(
  $$ insert into public.debts (name, installment_cents, first_due_date, n_installments) values ('X', 0, '2026-01-01', 1) $$,
  '23514', null,
  'una rata deve avere un importo'
);

-- Wishlist
insert into public.wishlist_items (id, name, price_cents) values ('90000000-0000-0000-0000-000000000001', 'Cuffie', 15000);
update public.wishlist_items set transaction_id = '60000000-0000-0000-0000-000000000002' where id = '90000000-0000-0000-0000-000000000001';
select is(
  (select transaction_id from public.wishlist_items where id = '90000000-0000-0000-0000-000000000001'),
  '60000000-0000-0000-0000-000000000002'::uuid,
  '"L''ho comprato" collega la spesa'
);
select throws_ok(
  $$ update public.wishlist_items set transaction_id = '60000000-0000-0000-0000-000000000005' where id = '90000000-0000-0000-0000-000000000001' $$,
  '23503', null,
  'non si può collegare la spesa di un altro utente'
);
delete from public.transactions where id = '60000000-0000-0000-0000-000000000002';
select is(
  (select transaction_id from public.wishlist_items where id = '90000000-0000-0000-0000-000000000001'),
  null::uuid,
  'eliminata la spesa, il desiderio torna da comprare'
);
select throws_ok(
  $$ insert into public.wishlist_items (name, price_cents) values ('Gratis', 0) $$,
  '23514', null,
  'un desiderio deve avere un prezzo'
);

-- Spese condivise
select bag_eq(
  $$ select person_id::text as persona, balance_cents as saldo from public.person_balances $$,
  $$ values
       ('80000000-0000-0000-0000-000000000001', -1500::bigint),
       ('80000000-0000-0000-0000-000000000002', 2000::bigint),
       ('80000000-0000-0000-0000-000000000003', 0::bigint) $$,
  'saldo per persona: positivo mi deve, negativo gli devo; le voci saldate non contano'
);
update public.shared_entries set settled = true where person_id = '80000000-0000-0000-0000-000000000002';
select is(
  (select balance_cents from public.person_balances where person_id = '80000000-0000-0000-0000-000000000002'),
  0::bigint,
  '"saldato" azzera il saldo'
);
delete from public.people where id = '80000000-0000-0000-0000-000000000002';
select is(
  (select count(*) from public.shared_entries where person_id = '80000000-0000-0000-0000-000000000002'),
  0::bigint,
  'eliminata una persona, spariscono le sue voci'
);
select throws_ok(
  $$ insert into public.shared_entries (person_id, description, amount_cents) values ('80000000-0000-0000-0000-000000000001', 'Zero', 0) $$,
  '23514', null,
  'una voce deve avere un importo'
);

-- Un altro utente non vede nulla.
select set_config('request.jwt.claims', '{"sub": "00000000-0000-0000-0000-00000000000b", "role": "authenticated"}', true);
select is(
  (select array[
    (select count(*) from public.debt_plan()),
    (select count(*) from public.wishlist_items),
    (select count(*) from public.people),
    (select count(*) from public.shared_entries),
    (select count(*) from public.person_balances)]),
  array[0, 0, 0, 0, 0]::bigint[],
  'debiti, desideri e spese condivise di un altro utente restano invisibili'
);
select is(
  (select array_agg(current_cents) from public.account_balances),
  array[4900]::bigint[],
  'il saldo attuale vede solo i propri conti e movimenti'
);
select throws_ok(
  $$ insert into public.shared_entries (person_id, description, amount_cents) values ('80000000-0000-0000-0000-000000000001', 'Intruso', 100) $$,
  '23503', null,
  'non si può aggiungere una voce alla persona di un altro utente'
);
reset role;

-- anon non ha accesso a nulla di tutto questo (controllo per nome: sicurezza.test copre il resto).
select is(has_table_privilege('anon', 'public.person_balances', 'select'), false, 'anon non legge i saldi');
select * from finish();
rollback;
