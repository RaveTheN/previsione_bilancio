-- Fase 5: ricorrenti (generazione, unione con i pagamenti reali, previsione predefinita). Dati finti.
begin;
create extension if not exists pgtap with schema extensions;
select plan(16);

-- Il job elabora le regole di tutti gli utenti: quelle già nel database locale falserebbero i conteggi.
delete from public.recurring_rules;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'a@example.com'),
  ('00000000-0000-0000-0000-00000000000b', 'b@example.com');
insert into public.accounts (id, user_id, name) values
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'Banca');
insert into public.buckets (id, user_id, name) values
  ('20000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'Future me'),
  ('20000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-00000000000a', 'Fun');
insert into public.categories (id, user_id, name, kind, is_salary, sort_order) values
  ('30000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'Stipendio', 'income', true, 1),
  ('30000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-00000000000a', 'Risparmio', 'saving', false, 2),
  ('30000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-00000000000a', 'Abbonamenti', 'expense', false, 3),
  ('30000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-00000000000a', 'Assicurazioni', 'expense', false, 4);
insert into public.settings (user_id, go_live_month, opening_residual_cents, savings_pct, savings_bucket_id) values
  ('00000000-0000-0000-0000-00000000000a', '2026-09-01', 0, 15, '20000000-0000-0000-0000-000000000001');
insert into public.cards (user_id, account_id, last4) values
  ('00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001', '1234');
insert into public.api_tokens (user_id, name, token_hash) values
  ('00000000-0000-0000-0000-00000000000a', 'iPhone', encode(sha256(convert_to('token-a', 'UTF8')), 'hex'));
insert into public.parse_rules (user_id, app, match_regex, action, amount_regex, merchant_regex, card_regex) values
  ('00000000-0000-0000-0000-00000000000a', 'BBVA', 'Pagamento accettato', 'expense',
   '([0-9][0-9.,]*)\s*EUR', 'presso\s+(.+?)\s+effettuato con', 'carta\s+\*+(\d{4})');

insert into public.recurring_rules
  (id, user_id, name, amount_cents, account_id, category_id, bucket_id, frequency, start_date, end_date, generated_until) values
  -- il 31 di ogni mese
  ('50000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'Servizio esempio', -1299,
   '10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-000000000002',
   'monthly', '2026-01-31', null, '2026-10-31'),
  -- annuale, il 15 marzo
  ('50000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-00000000000a', 'Polizza esempio', -50000,
   '10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000004', '20000000-0000-0000-0000-000000000002',
   'yearly', '2025-03-15', null, '2026-12-31'),
  -- finisce a novembre
  ('50000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-00000000000a', 'Disdetto', -1000,
   '10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-000000000002',
   'monthly', '2026-01-10', '2026-11-30', '2026-10-31'),
  -- il 20: a novembre il pagamento reale è già arrivato il 18
  ('50000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-00000000000a', 'Con pagamento reale', -777,
   '10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-000000000002',
   'monthly', '2026-01-20', null, '2026-10-31');
insert into public.transactions (id, user_id, account_id, amount_cents, booking_date, merchant_raw, source) values
  ('60000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001',
   -777, '2026-11-18', 'NEGOZIO ESEMPIO', 'notification');

select is(
  array[public.due_in_month('2026-02-01', 31), public.due_in_month('2028-02-01', 31),
        public.due_in_month('2026-04-01', 31), public.due_in_month('2026-04-01', 15)],
  array['2026-02-28', '2028-02-29', '2026-04-30', '2026-04-15']::date[],
  'il 31 diventa l''ultimo giorno nei mesi più corti'
);

select is(private.run_recurring('2026-11-30'), 2, 'alla scadenza crea i movimenti: uno per regola arrivata a scadenza');
select is(private.run_recurring('2026-11-30'), 0, 'rieseguire il job non crea doppioni');
select results_eq(
  $$ select category_id, bucket_id, note, source from public.transactions
     where recurring_rule_id = '50000000-0000-0000-0000-000000000001' $$,
  $$ values ('30000000-0000-0000-0000-000000000003'::uuid, '20000000-0000-0000-0000-000000000002'::uuid, 'Servizio esempio', 'recurring') $$,
  'il movimento ha categoria, secchio e nome della regola'
);
select results_eq(
  $$ select id, category_id, note from public.transactions
     where recurring_rule_id = '50000000-0000-0000-0000-000000000004' $$,
  $$ values ('60000000-0000-0000-0000-000000000001'::uuid, '30000000-0000-0000-0000-000000000003'::uuid, 'Con pagamento reale') $$,
  'pagamento reale già presente: si collega e si completa, senza raddoppiare'
);

select is(private.run_recurring('2027-03-31'), 9, 'dopo un periodo fermo recupera le scadenze perse (4 + 1 + 0 + 4)');
select is(
  (select array_agg(booking_date order by booking_date) from public.transactions
    where recurring_rule_id = '50000000-0000-0000-0000-000000000001'),
  array['2026-11-30', '2026-12-31', '2027-01-31', '2027-02-28', '2027-03-31']::date[],
  'mensile del 31: ultimo giorno nei mesi corti'
);
select is(
  (select array_agg(booking_date) from public.transactions
    where recurring_rule_id = '50000000-0000-0000-0000-000000000002'),
  array['2027-03-15']::date[],
  'annuale: una volta l''anno, nel mese della data di partenza'
);
select is(
  (select array_agg(booking_date) from public.transactions
    where recurring_rule_id = '50000000-0000-0000-0000-000000000003'),
  array['2026-11-10']::date[],
  'dopo la data di fine non si genera più'
);

-- Il pagamento reale che arriva dopo si unisce alla ricorrente (entro 3 giorni).
set local role anon;
select is(
  public.ingest('token-a', 'r1', '2027-04-01 10:00+02', 'BBVA', null, null,
    'Pagamento accettato 👍💳Pagamento di 12,99 EUR presso SERVIZIO ESEMPIO effettuato con la tua carta *1234') ->> 'status',
  'merged',
  'la notifica del pagamento si unisce alla ricorrente'
);
reset role;

insert into public.budget_lines (user_id, month, category_id, bucket_id, amount_cents) values
  ('00000000-0000-0000-0000-00000000000a', '2027-05-01', '30000000-0000-0000-0000-000000000001', null, 200000),
  -- marzo: la riga degli abbonamenti è scritta, quindi vince sulle ricorrenti
  ('00000000-0000-0000-0000-00000000000a', '2028-03-01', '30000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-000000000002', -2000);

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated"}', true);

select is(
  (select l from public.month_overview('2027-05-01', '2027-04-15') o, jsonb_array_elements(o -> 'lines') l
    where l ->> 'category_id' = '30000000-0000-0000-0000-000000000003') - 'category_id' - 'bucket_id' - 'inflow' - 'n',
  '{"forecast": -2076, "actual": 0, "is_default": true}'::jsonb,
  'previsione predefinita della riga: la somma delle sue ricorrenti attive (12,99 + 7,77)'
);
select is(
  (select jsonb_build_object('sav', o -> 'saving_forecast', 'exp', o -> 'expense_forecast')
   from public.month_overview('2027-05-01', '2027-04-15') o),
  '{"sav": -30000, "exp": -2076}'::jsonb,
  'la polizza annuale non pesa a maggio; il risparmio predefinito resta'
);
select is(
  (select jsonb_build_object(
     'abb', (select l -> 'forecast' from jsonb_array_elements(o -> 'lines') l where l ->> 'category_id' = '30000000-0000-0000-0000-000000000003'),
     'pol', (select l -> 'forecast' from jsonb_array_elements(o -> 'lines') l where l ->> 'category_id' = '30000000-0000-0000-0000-000000000004'))
   from public.month_overview('2028-03-01', '2027-04-15') o),
  '{"abb": -2000, "pol": -50000}'::jsonb,
  'la riga scritta vince sulle ricorrenti; l''annuale pesa nel suo mese'
);
select is(
  (select public.month_overview('2028-04-01', '2027-04-15') -> 'expense_forecast'),
  '0'::jsonb,
  'un mese non pianificato non ha previsione predefinita'
);

-- Una regola nuova non genera il passato. Regole di A invisibili a B.
insert into public.recurring_rules (name, amount_cents, account_id, category_id, start_date)
values ('Nuova', -100, '10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000003', '2020-01-01');
select is(
  (select generated_until from public.recurring_rules where name = 'Nuova'),
  (now() at time zone 'Europe/Rome')::date - 1,
  'una regola nuova parte da ieri: niente movimenti per il passato'
);
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000b","role":"authenticated"}', true);
select is((select count(*) from public.recurring_rules), 0::bigint, 'B non vede le regole di A');

select * from finish();
rollback;
