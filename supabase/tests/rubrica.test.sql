-- Fase 3b: Rubrica e assegnazione per esercente. Nomi finti, formati come quelli reali.
begin;
create extension if not exists pgtap with schema extensions;
select plan(15);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'a@example.com'),
  ('00000000-0000-0000-0000-00000000000b', 'b@example.com');
insert into public.accounts (id, user_id, name) values
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'Banca');
insert into public.buckets (id, user_id, name) values
  ('20000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'Fundamentals'),
  ('20000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-00000000000a', 'Fun');
insert into public.categories (id, user_id, name, kind) values
  ('30000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'Spesa', 'expense'),
  ('30000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-00000000000a', 'Uscite', 'expense');
insert into public.cards (user_id, account_id, last4) values
  ('00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001', '1234');
insert into public.api_tokens (user_id, name, token_hash) values
  ('00000000-0000-0000-0000-00000000000a', 'iPhone', encode(sha256(convert_to('token-a', 'UTF8')), 'hex'));
insert into public.parse_rules (user_id, app, match_regex, action, amount_regex, merchant_regex, card_regex) values
  ('00000000-0000-0000-0000-00000000000a', 'BBVA', 'Pagamento accettato', 'expense',
   '([0-9][0-9.,]*)\s*EUR', 'presso\s+(.+?)\s+effettuato con', 'carta\s+\*+(\d{4})');
-- Movimenti importati dall'estratto, ancora da assegnare tranne il terzo.
insert into public.transactions (id, user_id, account_id, category_id, bucket_id, amount_cents, booking_date, merchant_raw, source) values
  ('60000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001',
   null, null, -700, '2026-10-01', 'BAR ESEMPIO MUSIC B', 'import'),
  ('60000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001',
   null, null, -500, '2026-09-12', 'BAR ESEMPIO MUSIC B PALERMO IT', 'import'),
  ('60000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001',
   '30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', -300, '2026-09-20', 'BAR ESEMPIO MUSIC B', 'import'),
  ('60000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001',
   null, null, -150, '2026-10-02', 'SumUp  *Negozio esempio di', 'import'),
  ('60000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001',
   null, null, -250, '2026-10-03', 'SUMUP *NEGOZIO ESEMPIO 2', 'import'),
  ('60000000-0000-0000-0000-000000000006', '00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001',
   null, null, -100, '2026-10-04', 'SATISPAY', 'import');

select is(
  array[public.merchant_key('BAR ESEMPIO MUSIC B PALERMO IT'), public.merchant_key('SumUp  *Negozio esempio di'),
        public.merchant_key('PAYPAL *SERVIZIO ESEMPIO.IT'), public.merchant_key(' Lidl '), public.merchant_key(null)],
  array['BAR ESEMPIO MUSIC B', 'NEGOZIO ESEMPIO DI', 'SERVIZIO ESEMPIO.IT', 'LIDL', null],
  'chiave dell''esercente: maiuscole, spazi, prefissi degli intermediari e città finale'
);

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated"}', true);

select is(
  (select count(*) from public.merchant_inbox),
  4::bigint,
  'Da assegnare in Rubrica: un nome per esercente, anche con nomi grezzi diversi'
);

-- L'utente assegna il primo movimento a mano, poi l'app chiede di propagare.
update public.transactions set category_id = '30000000-0000-0000-0000-000000000002', bucket_id = '20000000-0000-0000-0000-000000000002'
where id = '60000000-0000-0000-0000-000000000001';
create temp table risultato as select public.assign_like('60000000-0000-0000-0000-000000000001') as r;

select is(
  (select jsonb_build_object('name', r -> 'name', 'n', jsonb_array_length(r -> 'rows')) from risultato),
  '{"name": "Bar Esempio Music B", "n": 1}'::jsonb,
  'assegnare un movimento assegna anche l''altro dello stesso esercente (nome grezzo diverso)'
);
select results_eq(
  $$ select id, category_id, bucket_id from public.transactions
     where id in ('60000000-0000-0000-0000-000000000002', '60000000-0000-0000-0000-000000000003') order by id $$,
  $$ values ('60000000-0000-0000-0000-000000000002'::uuid, '30000000-0000-0000-0000-000000000002'::uuid, '20000000-0000-0000-0000-000000000002'::uuid),
            ('60000000-0000-0000-0000-000000000003'::uuid, '30000000-0000-0000-0000-000000000001'::uuid, '20000000-0000-0000-0000-000000000001'::uuid) $$,
  'il movimento già assegnato a mano non cambia'
);
select results_eq(
  $$ select default_category_id, default_bucket_id from public.merchants where name = 'Bar Esempio Music B' $$,
  $$ values ('30000000-0000-0000-0000-000000000002'::uuid, '20000000-0000-0000-0000-000000000002'::uuid) $$,
  'l''assegnazione diventa la regola dell''esercente'
);

select public.undo_assign_like((select r from risultato));
select results_eq(
  $$ select category_id, bucket_id from public.transactions
     where id in ('60000000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000002') order by id $$,
  $$ values ('30000000-0000-0000-0000-000000000002'::uuid, '20000000-0000-0000-0000-000000000002'::uuid),
            (null::uuid, null::uuid) $$,
  'Annulla: torna da assegnare solo l''altro movimento; quello modificato a mano resta'
);
select is(
  (select default_category_id from public.merchants where name = 'Bar Esempio Music B'),
  null::uuid,
  'Annulla: anche la regola torna com''era'
);

-- Di nuovo, per le prove successive.
select public.assign_like('60000000-0000-0000-0000-000000000001');

-- Un movimento inserito dall'app con un nome grezzo prende esercente e regola (trigger).
insert into public.transactions (account_id, amount_cents, booking_date, merchant_raw)
values ('10000000-0000-0000-0000-000000000001', -900, '2026-10-05', 'Bar esempio music b PALERMO IT');
select results_eq(
  $$ select category_id, bucket_id from public.transactions where amount_cents = -900 $$,
  $$ values ('30000000-0000-0000-0000-000000000002'::uuid, '20000000-0000-0000-0000-000000000002'::uuid) $$,
  'un movimento nuovo dello stesso esercente arriva già assegnato'
);

-- Rubrica: un pattern "contiene" collega due nomi diversi a un esercente nuovo.
select is(
  public.link_alias('negozio esempio', true, 'Negozio sotto casa'),
  2,
  'pattern "contiene": collega tutti i movimenti passati che lo contengono'
);
-- Nomi generici da ignorare: niente esercente, niente propagazione.
insert into public.merchant_aliases (pattern, ignored) values ('SATISPAY', true);
select is(
  (select array_agg(key order by key) from public.merchant_inbox),
  null::text[],
  'Da assegnare si svuota: nomi collegati o ignorati'
);
update public.transactions set category_id = '30000000-0000-0000-0000-000000000001', bucket_id = '20000000-0000-0000-0000-000000000001'
where id = '60000000-0000-0000-0000-000000000006';
select is(
  public.assign_like('60000000-0000-0000-0000-000000000006'),
  null::jsonb,
  'un nome ignorato non crea esercenti né propaga'
);
select is(
  (select count(*) from public.merchants),
  2::bigint,
  'esercenti: il bar e il negozio'
);

-- Una notifica di quell'esercente arriva già con il nome, la categoria e il secchio.
reset role;
set local role anon;
select public.ingest('token-a', 'n1', '2026-10-18 20:48+02', 'BBVA', null, null,
  'Pagamento accettato 👍💳Pagamento di 7,00 EUR presso BAR ESEMPIO MUSIC B effettuato con la tua carta *1234');
reset role;
select results_eq(
  $$ select m.name, t.category_id, t.bucket_id from public.transactions t join public.merchants m on m.id = t.merchant_id
     where t.user_id = '00000000-0000-0000-0000-00000000000a' and t.source = 'notification' $$,
  $$ values ('Bar Esempio Music B', '30000000-0000-0000-0000-000000000002'::uuid, '20000000-0000-0000-0000-000000000002'::uuid) $$,
  'notifica: esercente riconosciuto, categoria e secchio dalla regola'
);

-- Utente B: non vede la Rubrica di A e non può propagare sui suoi movimenti.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000b","role":"authenticated"}', true);
select is(
  (select count(*) from public.merchants) + (select count(*) from public.merchant_aliases) + (select count(*) from public.merchant_inbox),
  0::bigint,
  'B non vede esercenti, alias e nomi da assegnare di A'
);
select is(
  public.assign_like('60000000-0000-0000-0000-000000000001'),
  null::jsonb,
  'B non può propagare sui movimenti di A'
);

select * from finish();
rollback;
