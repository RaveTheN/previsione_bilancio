-- Spostare una riga del mese in un altro secchio. Dati finti.
begin;
create extension if not exists pgtap with schema extensions;
select plan(6);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'a@example.com'),
  ('00000000-0000-0000-0000-00000000000b', 'b@example.com');
insert into public.accounts (id, user_id, name) values
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'Banca');
insert into public.buckets (id, user_id, name) values
  ('20000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'Fundamentals'),
  ('20000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-00000000000a', 'Fun');
insert into public.categories (id, user_id, name, kind) values
  ('30000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'Acquisti', 'expense');
-- Acquisti: 50 previsti in Fundamentals, 20 già in Fun; un movimento a novembre e uno a ottobre.
insert into public.budget_lines (user_id, month, category_id, bucket_id, amount_cents) values
  ('00000000-0000-0000-0000-00000000000a', '2026-11-01', '30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', -5000),
  ('00000000-0000-0000-0000-00000000000a', '2026-11-01', '30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000002', -2000);
insert into public.transactions (id, user_id, account_id, category_id, bucket_id, amount_cents, booking_date) values
  ('60000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001',
   '30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', -3000, '2026-11-05'),
  ('60000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001',
   '30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', -4000, '2026-10-05');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000b","role":"authenticated"}', true);
select public.move_month_row('2026-11-01', '30000000-0000-0000-0000-000000000001',
  '20000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000002');
select is(
  (select count(*) from public.budget_lines),
  0::bigint,
  'B non vede né sposta le righe di A'
);

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated"}', true);
select public.move_month_row('2026-11-01', '30000000-0000-0000-0000-000000000001',
  '20000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000002');
select results_eq(
  $$ select bucket_id, amount_cents from public.budget_lines order by bucket_id $$,
  $$ values ('20000000-0000-0000-0000-000000000002'::uuid, -7000::bigint) $$,
  'la previsione passa al nuovo secchio e si somma a quella che c''era'
);
select results_eq(
  $$ select id, bucket_id from public.transactions order by id $$,
  $$ values ('60000000-0000-0000-0000-000000000001'::uuid, '20000000-0000-0000-0000-000000000002'::uuid),
            ('60000000-0000-0000-0000-000000000002'::uuid, '20000000-0000-0000-0000-000000000001'::uuid) $$,
  'si spostano i movimenti del mese, non quelli degli altri mesi'
);
select throws_ok(
  $$ select public.move_month_row('2026-11-01', '30000000-0000-0000-0000-000000000001',
       '20000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000002') $$,
  '22023', null,
  'stesso secchio: rifiutato'
);

-- Eliminare la riga (ora in Fun): via la previsione, il movimento del mese torna da assegnare.
select is(
  public.delete_month_row('2026-11-01', '30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000002'),
  1,
  'eliminare la riga rimette da assegnare il suo movimento del mese'
);
select results_eq(
  $$ select (select count(*) from public.budget_lines),
            (select category_id from public.transactions where id = '60000000-0000-0000-0000-000000000001'),
            (select bucket_id from public.transactions where id = '60000000-0000-0000-0000-000000000001') $$,
  $$ values (0::bigint, '30000000-0000-0000-0000-000000000001'::uuid, null::uuid) $$,
  'la spesa tiene la categoria e perde il secchio; la previsione non c''è più'
);

select * from finish();
rollback;
