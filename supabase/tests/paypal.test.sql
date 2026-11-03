-- Fase 6: notifiche PayPal, autorizzazioni, regole modificabili. Testi finti, formati reali.
begin;
create extension if not exists pgtap with schema extensions;
select plan(24);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'a@example.com'),
  ('00000000-0000-0000-0000-00000000000b', 'b@example.com');
insert into public.accounts (id, user_id, name, role, sort_order) values
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'BBVA', 'spendable', 1);
insert into public.cards (user_id, account_id, last4) values
  ('00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001', '1234');
insert into public.api_tokens (user_id, name, token_hash) values
  ('00000000-0000-0000-0000-00000000000a', 'iPhone', encode(sha256(convert_to('token-a', 'UTF8')), 'hex'));
-- Le stesse regole di docs/setup-iniziale.sql.
insert into public.parse_rules (user_id, app, priority, match_regex, action, amount_regex, merchant_regex, card_regex) values
  ('00000000-0000-0000-0000-00000000000a', 'BBVA', 1, 'Pagamento accettato', 'expense',
   '([0-9][0-9.,]*)\s*EUR', 'presso\s+(.+?)\s+effettuato con', 'carta\s+\*+(\d{4})'),
  ('00000000-0000-0000-0000-00000000000a', 'PayPal', 1, 'You sent', 'expense', '€\s*([0-9][0-9.,]*)', 'You sent \S+ EUR to ([^\n]+)', null),
  ('00000000-0000-0000-0000-00000000000a', 'PayPal', 2, 'payment was completed', 'expense', '€\s*([0-9][0-9.,]*)', 'Your purchase at ([^\n]+)', null),
  ('00000000-0000-0000-0000-00000000000a', 'PayPal', 3, 'You authorized a payment', 'authorized', '€\s*([0-9][0-9.,]*)', 'Your purchase at ([^\n]+)', null);

create function pg_temp.bbva(id text, quando timestamptz, importo text, esercente text) returns text language sql as $$
  select public.ingest('token-a', id, quando, 'BBVA', null, null,
    'Pagamento accettato 👍💳Pagamento di ' || importo || ' EUR presso ' || esercente || ' effettuato con la tua carta *1234') ->> 'status'
$$;
create function pg_temp.pagato(id text, quando timestamptz, importo text, esercente text) returns text language sql as $$
  select public.ingest('token-a', id, quando, 'PayPal', 'Your purchase at ' || esercente, null,
    'Your €' || importo || ' EUR payment was completed. Tap for more details.') ->> 'status'
$$;
create function pg_temp.autorizzato(id text, quando timestamptz, importo text, esercente text) returns text language sql as $$
  select public.ingest('token-a', id, quando, 'PayPal', 'Your purchase at ' || esercente, null,
    'You authorized a payment of €' || importo || ' EUR. Tap for more details.') ->> 'status'
$$;

-- Banca e PayPal per lo stesso pagamento, nei due ordini: un movimento, con il nome "PAYPAL *X".
select is(pg_temp.bbva('a1', '2026-11-01 10:00+01', '4,99', 'PAYPAL *SERVIZIO'), 'created', 'prima la banca: movimento creato');
select is(pg_temp.pagato('a2', '2026-11-01 10:01+01', '4,99', 'Servizio Esempio, LLC'), 'merged', 'poi PayPal: unito');
select results_eq(
  $$ select account_id, merchant_raw, note, status from public.transactions where amount_cents = -499
     and user_id = '00000000-0000-0000-0000-00000000000a' $$,
  $$ values ('10000000-0000-0000-0000-000000000001'::uuid, 'PAYPAL *SERVIZIO', 'Servizio Esempio, LLC', 'confirmed') $$,
  'un solo movimento: nome della banca, nome PayPal nella nota'
);
select is(pg_temp.pagato('b1', '2026-11-02 10:00+01', '6,50', 'Altro Esempio SL'), 'created', 'prima PayPal: movimento creato');
select is(pg_temp.bbva('b2', '2026-11-02 10:01+01', '6,50', 'PAYPAL *ALTROESEMP'), 'merged', 'poi la banca: unito');
select results_eq(
  $$ select merchant_raw, note from public.transactions where amount_cents = -650
     and user_id = '00000000-0000-0000-0000-00000000000a' $$,
  $$ values ('PAYPAL *ALTROESEMP', 'Altro Esempio SL') $$,
  'in qualunque ordine vince il nome "PAYPAL *X", come nell''estratto'
);

-- Invio a una persona, con il punto decimale.
select is(
  public.ingest('token-a', 'c1', '2026-11-03 10:00+01', 'PayPal', 'PayPal', null, 'You sent €5.00 EUR to Mario Rossi') ->> 'status',
  'created', 'invio a una persona: movimento creato'
);
select results_eq(
  $$ select amount_cents, merchant_raw, account_id from public.transactions where merchant_raw = 'Mario Rossi' $$,
  $$ values (-500::bigint, 'Mario Rossi', '10000000-0000-0000-0000-000000000001'::uuid) $$,
  'importo col punto, nome della persona, primo conto spendibile'
);

-- Autorizzazione: resta da confermare finché non arriva l'addebito.
select is(pg_temp.autorizzato('d1', '2026-11-04 13:00+01', '19,40', 'CONSEGNE ESEMPIO SL'), 'created', 'autorizzazione: movimento creato');
select results_eq(
  $$ select status, review_reason from public.transactions where merchant_raw = 'CONSEGNE ESEMPIO SL' $$,
  $$ values ('pending', 'Autorizzato: in attesa dell''addebito') $$,
  'da confermare, con il motivo'
);
select is(pg_temp.bbva('d2', '2026-11-06 09:00+01', '19,40', 'PAYPAL *CONSEGNEES'), 'merged', 'addebito due giorni dopo, stesso importo: unito');
select results_eq(
  $$ select status, review_reason, merchant_raw, note, booking_date from public.transactions where amount_cents = -1940 $$,
  $$ values ('confirmed', null::text, 'PAYPAL *CONSEGNEES', 'CONSEGNE ESEMPIO SL', '2026-11-04'::date) $$,
  'confermato, con il nome dell''addebito e la data del pagamento'
);
-- Importo un po' diverso: con lo stesso nome si unisce e prende l'importo vero.
select is(pg_temp.autorizzato('e1', '2026-11-07 13:00+01', '20,00', 'PIZZERIA ESEMPIO'), 'created', 'seconda autorizzazione');
select is(pg_temp.bbva('e2', '2026-11-08 09:00+01', '21,50', 'PAYPAL *PIZZERIA'), 'merged', 'importo vicino e stesso nome: unito');
select is(
  (select count(*) from public.transactions where amount_cents = -2150 and status = 'confirmed' and merchant_raw = 'PAYPAL *PIZZERIA'),
  1::bigint, 'il movimento prende l''importo dell''addebito'
);
-- Un altro pagamento PayPal di importo vicino ma nome diverso non si unisce.
select is(pg_temp.autorizzato('f1', '2026-11-09 13:00+01', '30,00', 'NEGOZIO UNO'), 'created', 'terza autorizzazione');
select is(pg_temp.bbva('f2', '2026-11-10 09:00+01', '31,00', 'PAYPAL *ALTRO'), 'created', 'nome diverso e importo diverso: resta separato');

-- Un rifiuto non crea movimenti: finisce in Da rivedere.
select is(
  public.ingest('token-a', 'g1', '2026-11-11 10:00+01', 'BBVA', 'Pagamento rifiutato', null, 'Il pagamento di 9,00 EUR presso NEGOZIO è stato rifiutato') ->> 'status',
  'review', 'pagamento rifiutato: nessun movimento, in Da rivedere'
);
-- Codici in inglese: mai salvati. Un negozio con "code" nel nome invece passa.
select is(
  array[public.ingest('token-a', 'h1', '2026-11-11 10:00+01', 'PayPal', 'PayPal', null, 'Your security code is 123456') ->> 'status',
        public.ingest('token-a', 'h2', '2026-11-11 10:01+01', 'PayPal', 'PayPal', null, 'PayPal: 654321 is your code: do not share') ->> 'status',
        pg_temp.pagato('h3', '2026-11-11 10:02+01', '8,00', 'Code Academy Esempio')],
  array['ignored', 'ignored', 'created'],
  'i codici in inglese non vengono salvati; "code" in un nome di negozio sì'
);
select is(
  (select count(*) from public.ingest_events where body ~ '123456|654321'),
  0::bigint, 'nessun testo con un codice nel database'
);

-- Dall'app: prova di una regola e riprocessa dopo averla salvata.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated"}', true);
select results_eq(
  $$ select matched, amount_cents, merchant from public.test_parse('BBVA', 'rifiutato', '([0-9][0-9.,]*)\s*EUR', 'presso\s+(.+?)\s+è stato', null)
     order by occurred_at desc limit 1 $$,
  $$ values (true, 900::bigint, 'NEGOZIO') $$,
  'la prova dice cosa estrae una regola non ancora salvata'
);
select throws_ok(
  $$ insert into public.parse_rules (app, match_regex, action, amount_regex) values ('BBVA', '(', 'expense', 'x') $$,
  '2201B', null,
  'una regex non valida viene rifiutata al salvataggio'
);
insert into public.parse_rules (app, priority, match_regex, action) values ('BBVA', 5, 'rifiutato', 'ignore');
select is(
  public.reprocess_events(),
  '{"riconosciute": 1, "ancora_da_rivedere": 0}'::jsonb,
  'riprova tutte: la notifica viene riconosciuta dalla nuova regola'
);
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000b","role":"authenticated"}', true);
select is(
  (select count(*) from public.test_parse('BBVA', '.', '.', '.', '.')),
  0::bigint,
  'B non vede le notifiche di A nella prova'
);

select * from finish();
rollback;
