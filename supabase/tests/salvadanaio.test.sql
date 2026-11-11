-- Righe che muovono il Salvadanaio: "Prelievo dal Salvadanaio" e "Arrotonda acquisti". Dati finti.
-- "Oggi" è fissato con p_today, così i test non scadono.
begin;
create extension if not exists pgtap with schema extensions;
select plan(10);

insert into auth.users (id, email) values ('00000000-0000-0000-0000-00000000000a', 'a@example.com');
insert into public.accounts (id, user_id, name, role, balance_cents, balance_date) values
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'BBVA', 'spendable', null, null),
  -- Saldo di riferimento prima del mese di prova: i movimenti di novembre si aggiungono.
  ('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-00000000000a', 'Salvadanaio', 'reserve', 100000, '2026-10-31');
insert into public.buckets (id, user_id, name, sort_order, target_pct) values
  ('20000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'Future me', 1, 20),
  ('20000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-00000000000a', 'Fun', 2, 80);
insert into public.settings (user_id, go_live_month, opening_residual_cents, savings_bucket_id) values
  ('00000000-0000-0000-0000-00000000000a', '2026-11-01', 0, '20000000-0000-0000-0000-000000000001');
insert into public.budget_lines (user_id, month, name, bucket_id, amount_cents, sort_order) values
  ('00000000-0000-0000-0000-00000000000a', '2026-11-01', 'Stipendio', null, 200000, 1),
  ('00000000-0000-0000-0000-00000000000a', '2026-11-01', 'Prelievo dal Salvadanaio', null, 30000, 2),
  ('00000000-0000-0000-0000-00000000000a', '2026-11-01', 'Risparmio', '20000000-0000-0000-0000-000000000001', -10000, 3),
  ('00000000-0000-0000-0000-00000000000a', '2026-11-01', 'Arrotonda acquisti', '20000000-0000-0000-0000-000000000001', -2000, 4),
  ('00000000-0000-0000-0000-00000000000a', '2026-11-01', 'Svago', '20000000-0000-0000-0000-000000000002', -50000, 5);

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated"}', true);

-- Previsione, prima di qualsiasi movimento.
select is(
  (select jsonb_build_object(
     'in_f', o -> 'income_forecast', 'sav_f', o -> 'saving_forecast', 'out_f', o -> 'expense_forecast',
     'end_f', o -> 'end_forecast', 'pct', o -> 'buckets' -> 1 -> 'forecast_pct')
   from public.month_overview('2026-11-01', '2026-11-15') o),
  '{"in_f": 230000, "sav_f": -12000, "out_f": -50000, "end_f": 168000, "pct": 21.7}'::jsonb,
  'il prelievo è un''entrata (anche nella base delle %); Arrotonda acquisti è risparmio come Risparmio'
);
select is(
  (select jsonb_object_agg(l ->> 'name', l -> 'over_is_good')
   from public.month_overview('2026-11-01', '2026-11-15') o, jsonb_array_elements(o -> 'lines') l
   where l ->> 'name' in ('Arrotonda acquisti', 'Risparmio', 'Svago')),
  '{"Arrotonda acquisti": true, "Risparmio": true, "Svago": false}'::jsonb,
  'Arrotonda acquisti: superare il previsto è un bene, come il Risparmio'
);
select is(
  (select public.month_overview('2026-11-01', '2026-11-15') -> 'reserve_forecast'),
  '82000'::jsonb,
  'Salvadanaio previsto: 100000 + 10000 di Risparmio + 2000 di arrotondamenti − 30000 di prelievo'
);

-- Effettivo: i trasferimenti vanno sulla riga del loro verso.
select public.create_transfer('50000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002',
  '10000000-0000-0000-0000-000000000001', 30000, '2026-11-05', null);
select public.create_transfer('50000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000002', 10000, '2026-11-06', null);
select results_eq(
  $$ select b.name, t.amount_cents from public.transactions t
     join public.budget_lines b on b.id = t.line_id
     where t.transfer_group_id in ('50000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000002')
     order by t.amount_cents $$,
  $$ values ('Risparmio', -10000::bigint), ('Prelievo dal Salvadanaio', 30000::bigint) $$,
  'trasferimento dal Salvadanaio sulla riga Prelievo; verso il Salvadanaio sulla riga Risparmio'
);

-- Import: una riga può indicare la riga di destinazione (gli arrotondamenti).
reset role;
select private.import_statement('00000000-0000-0000-0000-00000000000a', $$[
  {"id": "70000000-0000-0000-0000-000000000001", "account": "BBVA", "amount": -137, "booking_date": "2026-11-10", "value_date": "2026-11-10", "merchant": "ARROTONDAMENTO", "grp": "80000000-0000-0000-0000-000000000001", "line": "Arrotonda acquisti"},
  {"id": "70000000-0000-0000-0000-000000000002", "account": "Salvadanaio", "amount": 137, "booking_date": "2026-11-10", "value_date": "2026-11-10", "merchant": "ARROTONDAMENTO", "grp": "80000000-0000-0000-0000-000000000001", "line": "Arrotonda acquisti"},
  {"id": "70000000-0000-0000-0000-000000000003", "account": "BBVA", "amount": 4000, "booking_date": "2026-11-12", "value_date": "2026-11-12", "merchant": "PROGRAMMA", "grp": "80000000-0000-0000-0000-000000000002"},
  {"id": "70000000-0000-0000-0000-000000000004", "account": "Salvadanaio", "amount": -4000, "booking_date": "2026-11-12", "value_date": "2026-11-12", "merchant": "PROGRAMMA", "grp": "80000000-0000-0000-0000-000000000002"}
]$$::jsonb);
set local role authenticated;
select results_eq(
  $$ select t.id, b.name from public.transactions t
     left join public.budget_lines b on b.id = t.line_id
     where t.id::text like '70000000-%' order by t.id $$,
  $$ values ('70000000-0000-0000-0000-000000000001'::uuid, 'Arrotonda acquisti'),
            ('70000000-0000-0000-0000-000000000002'::uuid, null),
            ('70000000-0000-0000-0000-000000000003'::uuid, 'Prelievo dal Salvadanaio'),
            ('70000000-0000-0000-0000-000000000004'::uuid, null) $$,
  'import: il lato BBVA va sulla riga indicata, o su quella del verso; il lato Salvadanaio su nessuna'
);
select is(
  (select jsonb_object_agg(l ->> 'name', l -> 'actual')
   from public.month_overview('2026-11-01', '2026-11-15') o, jsonb_array_elements(o -> 'lines') l
   where l ->> 'name' in ('Prelievo dal Salvadanaio', 'Risparmio', 'Arrotonda acquisti')),
  '{"Prelievo dal Salvadanaio": 34000, "Risparmio": -10000, "Arrotonda acquisti": -137}'::jsonb,
  'effettivo delle tre righe'
);
select is(
  (select jsonb_build_object('in_a', o -> 'income_actual', 'sav_a', o -> 'saving_actual', 'reserve_a', o -> 'reserve_actual')
   from public.month_overview('2026-11-01', '2026-11-15') o),
  '{"in_a": 34000, "sav_a": -10137, "reserve_a": 76137}'::jsonb,
  'Salvadanaio effettivo: 100000 − 30000 − 4000 + 10000 + 137'
);
select is(
  (select public.month_overview('2026-11-01', '2026-11-15') -> 'reserve_forecast'),
  '76137'::jsonb,
  'con dei movimenti il previsto segue l''effettivo delle righe: 100000 − 34000 + 10000 + 137'
);

-- Dicembre si copia da novembre: le due righe restano collegate al Salvadanaio anche lì.
select is(public.ensure_month_lines('2026-12-01'), 5, 'dicembre copia le cinque righe di novembre');
select is(
  (select public.month_overview('2026-12-01', '2026-11-15') -> 'reserve_forecast'),
  '58137'::jsonb,
  'mesi futuri: il Salvadanaio previsto prosegue con le righe copiate (76137 − 30000 + 10000 + 2000)'
);

select * from finish();
rollback;
