-- Righe del mese: copia automatica, movimenti che cambiano mese, eliminazione. Dati finti.
begin;
create extension if not exists pgtap with schema extensions;
select plan(8);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'a@example.com'),
  ('00000000-0000-0000-0000-00000000000b', 'b@example.com');
insert into public.accounts (id, user_id, name) values
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'Banca');
insert into public.buckets (id, user_id, name) values
  ('20000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'Fundamentals'),
  ('20000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-00000000000a', 'Fun');
insert into public.settings (user_id, go_live_month) values
  ('00000000-0000-0000-0000-00000000000a', '2026-10-01');
insert into public.budget_lines (id, user_id, month, name, bucket_id, amount_cents, sort_order) values
  ('30000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', '2026-11-01', 'Luce', '20000000-0000-0000-0000-000000000001', -3000, 1),
  ('30000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-00000000000a', '2026-11-01', 'Barbiere', '20000000-0000-0000-0000-000000000002', -1500, 2);
insert into public.transactions (id, user_id, account_id, line_id, amount_cents, booking_date) values
  ('60000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001',
   '30000000-0000-0000-0000-000000000001', -12000, '2026-11-05'),
  ('60000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001',
   '30000000-0000-0000-0000-000000000002', -1500, '2026-11-06');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000b","role":"authenticated"}', true);
select is(public.ensure_month_lines('2026-12-01'), 0, 'B non copia le righe di A');

select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated"}', true);
select is(public.ensure_month_lines('2027-01-01'), 2, 'un mese vuoto copia le righe dell''ultimo mese che ne ha');
select results_eq(
  $$ select name, bucket_id, amount_cents, sort_order from public.budget_lines where month = '2027-01-01' order by sort_order $$,
  $$ values ('Luce', '20000000-0000-0000-0000-000000000001'::uuid, -3000::bigint, 1),
            ('Barbiere', '20000000-0000-0000-0000-000000000002'::uuid, -1500::bigint, 2) $$,
  'si copiano nome, secchio, previsto e ordine'
);
select is(
  public.ensure_month_lines('2027-01-01') + public.ensure_month_lines('2026-09-01'),
  0,
  'un mese con righe non si tocca, e prima del mese di avvio non si copia'
);

-- Il movimento cambia mese: passa alla riga con lo stesso nome (dicembre si copia), o torna da assegnare.
update public.transactions set booking_date = '2026-12-03' where id = '60000000-0000-0000-0000-000000000001';
select is(
  (select b.month || ' ' || b.name from public.transactions t join public.budget_lines b on b.id = t.line_id
    where t.id = '60000000-0000-0000-0000-000000000001'),
  '2026-12-01 Luce',
  'cambiando data il movimento passa alla riga con lo stesso nome nel nuovo mese'
);
delete from public.budget_lines where month = '2026-10-01';
update public.transactions set booking_date = '2026-10-03' where id = '60000000-0000-0000-0000-000000000002';
select is(
  (select line_id from public.transactions where id = '60000000-0000-0000-0000-000000000002'),
  null,
  'senza la riga nel nuovo mese torna da assegnare'
);

-- Eliminare la riga rimette da assegnare i suoi movimenti.
update public.transactions set line_id = '30000000-0000-0000-0000-000000000002', booking_date = '2026-11-06'
where id = '60000000-0000-0000-0000-000000000002';
delete from public.budget_lines where id = '30000000-0000-0000-0000-000000000002';
select is(
  (select line_id from public.transactions where id = '60000000-0000-0000-0000-000000000002'),
  null,
  'eliminare la riga rimette da assegnare il suo movimento'
);

-- Spostare una riga in un altro secchio: i movimenti la seguono.
update public.budget_lines set bucket_id = '20000000-0000-0000-0000-000000000002' where month = '2026-12-01' and name = 'Luce';
select is(
  (select l ->> 'actual' from public.month_overview('2026-12-01') o, jsonb_array_elements(o -> 'lines') l
    where l ->> 'name' = 'Luce' and l ->> 'bucket_id' = '20000000-0000-0000-0000-000000000002'),
  '-12000',
  'spostata in Fun, la riga si porta dietro i suoi movimenti'
);

select * from finish();
rollback;
