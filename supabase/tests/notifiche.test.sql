-- Fase 3a: ingresso delle notifiche (token, parsing, deduplica, privacy). Testi finti.
begin;
create extension if not exists pgtap with schema extensions;
select plan(21);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'a@example.com'),
  ('00000000-0000-0000-0000-00000000000b', 'b@example.com');
insert into public.accounts (id, user_id, name, role, sort_order) values
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'Banca', 'spendable', 1),
  ('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-00000000000a', 'Riserva', 'reserve', 2);
insert into public.cards (user_id, account_id, last4) values
  ('00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001', '1234');
insert into public.api_tokens (user_id, name, token_hash, revoked_at) values
  ('00000000-0000-0000-0000-00000000000a', 'iPhone', encode(sha256(convert_to('token-a', 'UTF8')), 'hex'), null),
  ('00000000-0000-0000-0000-00000000000a', 'Vecchio', encode(sha256(convert_to('token-vecchio', 'UTF8')), 'hex'), now());
-- Le stesse regole di docs/setup-iniziale.sql.
insert into public.parse_rules (user_id, app, priority, match_regex, action, amount_regex, merchant_regex, card_regex) values
  ('00000000-0000-0000-0000-00000000000a', 'BBVA', 1, 'Pagamento accettato', 'expense',
   '([0-9][0-9.,]*)\s*EUR', 'presso\s+(.+?)\s+effettuato con', 'carta\s+\*+(\d{4})'),
  ('00000000-0000-0000-0000-00000000000a', 'BBVA', 2, 'rateizzare questo acquisto', 'expense',
   '([0-9][0-9.,]*)\s*EUR', 'presso\s+(.+?)\s+con la tua carta', 'carta\s+\*+(\d{4})');
-- Un movimento inserito a mano prima che arrivi la notifica.
insert into public.transactions (id, user_id, account_id, amount_cents, booking_date, source) values
  ('60000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a',
   '10000000-0000-0000-0000-000000000001', -350, '2026-10-17', 'manual');
-- Un evento di 100 giorni fa, con il testo ancora presente.
insert into public.ingest_events (user_id, client_event_id, occurred_at, app, body, status, created_at) values
  ('00000000-0000-0000-0000-00000000000a', 'vecchio', now() - interval '100 days', 'BBVA', 'testo vecchio', 'ignored',
   now() - interval '100 days');

select is(
  array[private.parse_amount('13,00'), private.parse_amount('7.5'), private.parse_amount('1.234,56'),
        private.parse_amount('1.234'), private.parse_amount('0,01 €'), private.parse_amount('abc')],
  array[1300, 750, 123456, 123400, 1, null]::bigint[],
  'importi testuali → centesimi'
);

-- Da qui come il Comando Rapido: ruolo anon, solo il token.
set local role anon;

select throws_ok(
  $$ select public.ingest('sbagliato', 'x1', now(), 'BBVA', null, null, 'Pagamento accettato') $$,
  'PT401', 'invalid_token', 'token errato: 401, nulla salvato'
);
select throws_ok(
  $$ select public.ingest('token-vecchio', 'x2', now(), 'BBVA', null, null, 'Pagamento accettato') $$,
  'PT401', 'invalid_token', 'token revocato: 401'
);
select throws_ok(
  $$ select public.ingest('token-a', 'x3', now(), 'BBVA', null, null, repeat('a', 2001)) $$,
  'PT400', 'invalid_payload', 'testo troppo lungo: 400'
);
select is(
  public.ingest('token-a', 'e1', '2026-10-16 22:39+02', 'BBVA', '', '',
    'Pagamento accettato 👍💳Pagamento di 12,00 EUR presso BOTTEGA ESEMPIO effettuato con la tua carta *1234') ->> 'status',
  'created',
  'notifica di pagamento: movimento creato'
);
select is(
  public.ingest('token-a', 'e1', '2026-10-16 22:39+02', 'BBVA', '', '',
    'Pagamento accettato 👍💳Pagamento di 12,00 EUR presso BOTTEGA ESEMPIO effettuato con la tua carta *1234') ->> 'status',
  'duplicate',
  'stesso evento reinviato: riconosciuto come doppione'
);
select is(
  public.ingest('token-a', 'e2', '2026-10-16 22:41+02', 'BBVA', 'Acquisto approvato', '',
    'Puoi rateizzare questo acquisto da 12,00 EUR presso BOTTEGA ESEMPIO con la tua carta *1234. Simula le rate.') ->> 'status',
  'merged',
  'secondo modello di notifica per lo stesso pagamento: unito'
);
select is(
  array[public.ingest('token-a', 'c1', '2026-10-17 09:00+02', 'BBVA', null, null,
          'Pagamento accettato 👍💳Pagamento di 1,20 EUR presso BAR ESEMPIO effettuato con la tua carta *1234') ->> 'status',
        public.ingest('token-a', 'c2', '2026-10-17 09:10+02', 'BBVA', null, null,
          'Pagamento accettato 👍💳Pagamento di 1,20 EUR presso BAR ESEMPIO effettuato con la tua carta *1234') ->> 'status'],
  array['created', 'created'],
  'due caffè uguali a dieci minuti: due movimenti'
);
select is(
  public.ingest('token-a', 'm1', '2026-10-17 18:00+02', 'BBVA', null, null,
    'Pagamento accettato 👍💳Pagamento di 3,50 EUR presso EDICOLA ESEMPIO effettuato con la tua carta *1234') ->> 'status',
  'merged',
  'la notifica di una spesa già inserita a mano si unisce a quella'
);
select is(
  public.ingest('token-a', 'k1', '2026-10-18 12:00+02', 'BBVA', null, null,
    'Pagamento accettato 👍💳Pagamento di 5,00 EUR presso NEGOZIO ESEMPIO effettuato con la tua carta *9999') ->> 'status',
  'created',
  'carta sconosciuta: il movimento si crea comunque'
);
select is(
  public.ingest('token-a', 'u1', '2026-10-18 13:00+02', 'BBVA', 'Bonifico', null, 'Hai ricevuto un bonifico di 50,00 EUR') ->> 'status',
  'review',
  'notifica non riconosciuta: va in Da rivedere'
);
select is(
  public.ingest('token-a', 's1', '2026-10-18 14:00+02', 'BBVA', null, null, 'Il tuo codice OTP è 123456') ->> 'status',
  'ignored',
  'codice di sicurezza: ignorato'
);
select throws_ok(
  $$ select count(*) from public.ingest_events $$,
  '42501', null,
  'il token non legge nulla: anon non accede agli eventi'
);

-- Verifiche sul database, come proprietario.
reset role;

select results_eq(
  $$ select account_id, amount_cents, merchant_raw, source, booking_date, review_reason
     from public.transactions where user_id = '00000000-0000-0000-0000-00000000000a' and merchant_raw like 'BOTTEGA%' $$,
  $$ values ('10000000-0000-0000-0000-000000000001'::uuid, -1200::bigint, 'BOTTEGA ESEMPIO', 'notification',
             '2026-10-16'::date, null::text) $$,
  'un solo movimento per la bottega, sul conto della carta, con data italiana'
);
select is(
  (select merchant_raw from public.transactions where id = '60000000-0000-0000-0000-000000000001'),
  'EDICOLA ESEMPIO',
  'il movimento inserito a mano prende l''esercente dalla notifica'
);
select is(
  (select review_reason from public.transactions where user_id = '00000000-0000-0000-0000-00000000000a' and amount_cents = -500),
  'Carta *9999 non collegata a un conto',
  'carta sconosciuta: movimento da controllare, sul primo conto spendibile'
);
select is(
  (select count(*) from public.ingest_events where user_id = '00000000-0000-0000-0000-00000000000a' and body ~* 'codice'),
  0::bigint,
  'il testo con il codice di sicurezza non è stato salvato'
);
select is(
  (select body from public.ingest_events where client_event_id = 'vecchio'),
  null::text,
  'i testi più vecchi di 90 giorni vengono cancellati'
);

-- "Riprova": dopo aver aggiunto una regola, la notifica non riconosciuta diventa un'entrata.
insert into public.parse_rules (user_id, app, priority, match_regex, action, amount_regex) values
  ('00000000-0000-0000-0000-00000000000a', 'BBVA', 3, 'ricevuto un bonifico', 'income', '([0-9][0-9.,]*)\s*EUR');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000b","role":"authenticated"}', true);
select throws_ok(
  format('select public.reprocess_event(%L)', (select id from public.ingest_events where client_event_id = 'u1')),
  '22023', 'Notifica non trovata',
  'B non può riprocessare le notifiche di A'
);
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated"}', true);
select is(
  (select public.reprocess_event(id) ->> 'status' from public.ingest_events where client_event_id = 'u1'),
  'created',
  'riprova dopo la nuova regola: entrata creata'
);

-- Limite di frequenza: 120 eventi nell'ultima ora.
reset role;
insert into public.ingest_events (user_id, client_event_id, occurred_at, app, status)
select '00000000-0000-0000-0000-00000000000a', 'riempi' || n, now(), 'BBVA', 'ignored' from generate_series(1, 120) n;
set local role anon;
select throws_ok(
  $$ select public.ingest('token-a', 'troppi', now(), 'BBVA', null, null, 'Pagamento accettato') $$,
  'PT429', 'rate_limited', 'oltre 120 notifiche all''ora: 429'
);

select * from finish();
rollback;
