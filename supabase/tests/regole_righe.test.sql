-- Regole che parlano con le righe: riga della regola, entrata prevista, importo da inserire.
begin;
create extension if not exists pgtap with schema extensions;
select plan(13);

insert into auth.users (id, email) values ('00000000-0000-0000-0000-00000000000a', 'a@example.com');
insert into public.accounts (id, user_id, name, role, sort_order) values
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'BBVA', 'spendable', 1);
insert into public.cards (user_id, account_id, last4) values
  ('00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001', '1234');
insert into public.api_tokens (user_id, name, token_hash) values
  ('00000000-0000-0000-0000-00000000000a', 'iPhone', encode(sha256(convert_to('token-a', 'UTF8')), 'hex'));
insert into public.buckets (id, user_id, name, sort_order) values
  ('20000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'Fundamentals', 1);
insert into public.settings (user_id, go_live_month) values ('00000000-0000-0000-0000-00000000000a', '2026-11-01');
insert into public.budget_lines (user_id, month, name, bucket_id, amount_cents) values
  ('00000000-0000-0000-0000-00000000000a', '2026-11-01', 'Contanti', '20000000-0000-0000-0000-000000000001', -10000),
  ('00000000-0000-0000-0000-00000000000a', '2026-11-01', 'Arrotonda acquisti', '20000000-0000-0000-0000-000000000001', -300);
insert into public.parse_rules (user_id, app, priority, match_regex, action, amount_regex, merchant_regex, card_regex, line_name) values
  ('00000000-0000-0000-0000-00000000000a', 'BBVA', 1, 'Prelievo accettato', 'expense',
   '([0-9][0-9.,]*)\s*EUR', null, 'carta\s+\*+(\d{4})', 'Contanti'),
  ('00000000-0000-0000-0000-00000000000a', 'BBVA', 2, 'Rimborso accettato', 'forecast',
   '([0-9][0-9.,]*)\s*EUR', 'presso\s+(.+?)\s+effettuato con', null, null),
  ('00000000-0000-0000-0000-00000000000a', 'BBVA', 3, 'Arrotonda acquisti', 'expense', null, null, null, 'Arrotonda acquisti');

-- Prelievo: movimento sulla riga "Contanti", senza passare da Da rivedere.
select is(
  public.ingest('token-a', 'p1', '2026-11-03 10:00+01', 'BBVA', null, null,
    'Prelievo accettato 👍💶Prelievo di 100,00 EUR effettuato con la tua carta *1234') ->> 'status',
  'created', 'prelievo: movimento creato');
select results_eq(
  $$ select t.amount_cents, b.name, t.review_reason from public.transactions t
     join public.budget_lines b on b.id = t.line_id where t.user_id = '00000000-0000-0000-0000-00000000000a' $$,
  $$ values (-10000::bigint, 'Contanti', null::text) $$,
  'sulla riga Contanti, niente da rivedere');

-- Rimborso: una riga tra le Entrate con il previsto, nessun movimento.
select is(
  public.ingest('token-a', 'r1', '2026-11-07 10:00+01', 'BBVA', null, null,
    'Rimborso accettato 👍🔙Rimborso di 37,05 EUR presso NEGOZIO effettuato con la tua carta *1234') ->> 'status',
  'created', 'rimborso: riga creata');
select results_eq(
  $$ select name, amount_cents from public.budget_lines where month = '2026-11-01' and bucket_id is null and user_id = '00000000-0000-0000-0000-00000000000a' $$,
  $$ values ('Rimborso NEGOZIO', 3705::bigint) $$,
  'riga delle Entrate con il previsto');
select is((select count(*) from public.transactions where user_id = '00000000-0000-0000-0000-00000000000a'), 1::bigint, 'nessun movimento per il rimborso');
-- Riga già creata a mano con lo stesso previsto: niente doppione.
select is(
  public.ingest('token-a', 'r2', '2026-11-08 10:00+01', 'BBVA', null, null,
    'Rimborso accettato 👍🔙Rimborso di 37,05 EUR presso ALTRO NOME effettuato con la tua carta *1234') ->> 'status',
  'merged', 'stesso previsto: riga già presente');
select is((select count(*) from public.budget_lines where month = '2026-11-01' and bucket_id is null and user_id = '00000000-0000-0000-0000-00000000000a'), 1::bigint,
  'una sola riga di rimborso');

-- Arrotonda acquisti: senza importo resta in Da rivedere, legata alla regola.
select is(
  public.ingest('token-a', 'x1', '2026-11-10 10:00+01', 'BBVA', 'Arrotonda acquisti ', null,
    'Scopri quanto hai risparmiato con la regola Arrotonda acquisti.') ->> 'status',
  'review', 'senza importo: in Da rivedere');
select is(
  (select error from public.ingest_events where client_event_id = 'x1'), 'Importo da inserire', 'con il motivo');

set local role authenticated;
set local request.jwt.claims to '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}';
select throws_ok(
  $$ select public.complete_event((select id from public.ingest_events where client_event_id = 'r1'), 100) $$,
  '22023', null, 'una notifica che non aspetta un importo si rifiuta');
select lives_ok(
  $$ select public.complete_event((select id from public.ingest_events where client_event_id = 'x1'), 227) $$,
  'importo scritto in Da rivedere');
select results_eq(
  $$ select t.amount_cents, b.name, t.booking_date, t.source from public.transactions t
     join public.budget_lines b on b.id = t.line_id where b.name = 'Arrotonda acquisti' $$,
  $$ values (-227::bigint, 'Arrotonda acquisti', '2026-11-10'::date, 'notification') $$,
  'movimento sulla riga Arrotonda acquisti, nel giorno della notifica');
select is(
  (select status from public.ingest_events where client_event_id = 'x1'), 'created', 'la notifica esce da Da rivedere');

select * from finish();
rollback;
