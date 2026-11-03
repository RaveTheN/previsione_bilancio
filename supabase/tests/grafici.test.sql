-- Fase 8: dati dei grafici, coerenti con la vista mese. Dati finti.
begin;
create extension if not exists pgtap with schema extensions;
select plan(14);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'a@example.com'),
  ('00000000-0000-0000-0000-00000000000b', 'b@example.com');
insert into public.accounts (id, user_id, name) values
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'Banca');
insert into public.buckets (id, user_id, name, target_pct) values
  ('20000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'Fun', 35);
insert into public.categories (id, user_id, name, kind, is_salary, sort_order) values
  ('30000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'Stipendio', 'income', true, 1),
  ('30000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-00000000000a', 'Abbonamenti', 'expense', false, 2),
  ('30000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-00000000000a', 'Risparmio', 'saving', false, 3);
insert into public.settings (user_id, go_live_month, opening_residual_cents, savings_pct) values
  ('00000000-0000-0000-0000-00000000000a', '2026-09-01', 0, 15);

-- La Rubrica riunisce due nomi della banca sotto un solo esercente.
insert into public.merchants (id, user_id, name) values
  ('40000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'Il Bar');
insert into public.merchant_aliases (user_id, merchant_id, pattern) values
  ('00000000-0000-0000-0000-00000000000a', '40000000-0000-0000-0000-000000000001', 'BAR ESEMPIO SRL'),
  ('00000000-0000-0000-0000-00000000000a', '40000000-0000-0000-0000-000000000001', 'BAR ESEMPIO');
insert into public.merchant_aliases (user_id, pattern, ignored) values
  ('00000000-0000-0000-0000-00000000000a', 'GENERICO PAY', true);

insert into public.recurring_rules
  (id, user_id, name, amount_cents, account_id, category_id, bucket_id, frequency, start_date, end_date, generated_until) values
  -- Il 5 di ogni mese, elaborata fino a ottobre: ha un movimento a ottobre, poi solo previsioni.
  ('50000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'Mensile', -1000,
   '10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000001',
   'monthly', '2026-01-05', null, '2026-10-31'),
  -- Annuale a dicembre, già finita al 2026-11-15: ultima scadenza nel 2025.
  ('50000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-00000000000a', 'Annuale finita', -50000,
   '10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000001',
   'yearly', '2024-12-10', '2026-01-01', '2026-10-31'),
  -- Un'entrata e un accantonamento non sono costi.
  ('50000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-00000000000a', 'Entrata', 1000,
   '10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', null,
   'monthly', '2026-01-05', null, '2026-10-31'),
  ('50000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-00000000000a', 'Accantonamento', -1000,
   '10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-000000000001',
   'monthly', '2026-01-05', null, '2026-10-31');

insert into public.transactions
  (user_id, account_id, category_id, bucket_id, amount_cents, booking_date, merchant_raw, status, transfer_group_id, recurring_rule_id) values
  ('00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', null, 200000, '2026-10-01', null, 'confirmed', null, null),
  ('00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001', null, null, -1000, '2026-10-02', 'BAR ESEMPIO SRL', 'confirmed', null, null),
  ('00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001', null, null, -500, '2026-10-03', 'BAR ESEMPIO', 'confirmed', null, null),
  -- Reso: si sottrae allo stesso esercente.
  ('00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001', null, null, 200, '2026-10-04', 'BAR ESEMPIO', 'confirmed', null, null),
  -- Senza Rubrica: vale il nome della banca, ripulito.
  ('00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001', null, null, -4000, '2026-10-05', 'SUMUP *NEGOZIO', 'confirmed', null, null),
  -- Fuori dalla classifica: operazione generica, nome ignorato, rifiutato, trasferimento, mese futuro, solo entrate.
  ('00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001', null, null, -9000, '2026-10-06', 'BONIFICO ESEGUITO', 'confirmed', null, null),
  ('00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001', null, null, -9000, '2026-10-07', 'GENERICO PAY', 'confirmed', null, null),
  ('00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001', null, null, -9000, '2026-10-08', 'RIFIUTATO', 'declined', null, null),
  ('00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001', null, null, -9000, '2026-10-09', 'GIROCONTO', 'confirmed', '70000000-0000-0000-0000-000000000001', null),
  ('00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001', null, null, -9000, '2026-12-09', 'FUTURO', 'confirmed', null, null),
  ('00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001', null, null, 9000, '2026-10-10', 'RIMBORSO', 'confirmed', null, null),
  -- Pagamento della ricorrente, con un importo diverso dal previsto: conta quello reale.
  ('00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000001', -1100, '2026-10-05', null, 'confirmed', null, '50000000-0000-0000-0000-000000000001');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "00000000-0000-0000-0000-00000000000a", "role": "authenticated"}', true);

create temp table risultato on commit drop as
select public.chart_data('2026-09-15', '2026-12-20', '2026-11-15') as d;

select is(
  (select jsonb_agg(m ->> 'month') from risultato, jsonb_array_elements(d -> 'months') m),
  '["2026-09-01", "2026-10-01", "2026-11-01", "2026-12-01"]'::jsonb,
  'il periodo arriva ai mesi interi, in ordine'
);
select is(
  (select (d -> 'months' -> 1) - 'month' from risultato),
  public.month_overview('2026-10-01', '2026-11-15'),
  'ogni mese è esattamente la sua vista mese'
);
select is(
  (select (d -> 'months' -> 3) - 'month' from risultato),
  public.month_overview('2026-12-01', '2026-11-15'),
  'anche i mesi futuri coincidono con griglia e vista mese'
);

select is(
  (select jsonb_agg(m ->> 'name') from risultato, jsonb_array_elements(d -> 'merchants') m),
  '["NEGOZIO", "Il Bar"]'::jsonb,
  'classifica per spesa: generiche, ignorati, rifiutati, trasferimenti, mesi futuri e sole entrate restano fuori'
);
select is(
  (select (d -> 'merchants' -> 1 ->> 'cents')::bigint from risultato),
  1300::bigint,
  'due nomi della banca sotto un solo esercente, con il reso sottratto'
);
select is(
  (select (d -> 'merchants' -> 0 ->> 'cents')::bigint from risultato),
  4000::bigint,
  'senza Rubrica vale il nome della banca ripulito'
);

select is(
  (select jsonb_agg(r ->> 'name') from risultato, jsonb_array_elements(d -> 'recurring') r),
  '["Annuale finita", "Mensile"]'::jsonb,
  'solo le spese, dalla più costosa all''anno: entrate e accantonamenti restano fuori'
);
select is(
  (select r -> 'months' from risultato, jsonb_array_elements(d -> 'recurring') r where r ->> 'name' = 'Mensile'),
  '{"2026-10-01": 1100, "2026-11-01": 1000, "2026-12-01": 1000}'::jsonb,
  'nei mesi elaborati vale il movimento reale, nei successivi l''importo previsto, senza doppioni'
);
select is(
  (select r -> 'months' from risultato, jsonb_array_elements(d -> 'recurring') r where r ->> 'name' = 'Annuale finita'),
  '{}'::jsonb,
  'dopo la fine una ricorrente non costa più nulla'
);
select is(
  (select array_agg((r ->> 'yearly')::bigint order by r ->> 'name') from risultato, jsonb_array_elements(d -> 'recurring') r),
  array[50000, 12000]::bigint[],
  'costo annuo: una volta le annuali, dodici le mensili'
);
select is(
  (select array_agg((r ->> 'active')::boolean order by r ->> 'name') from risultato, jsonb_array_elements(d -> 'recurring') r),
  array[false, true],
  'una ricorrente finita non è più attiva'
);

-- Un altro utente non vede nulla.
select set_config('request.jwt.claims', '{"sub": "00000000-0000-0000-0000-00000000000b", "role": "authenticated"}', true);
select is(
  (select array[d -> 'merchants', d -> 'recurring'] from (select public.chart_data('2026-09-01', '2026-12-01', '2026-11-15') as d) x),
  array['[]'::jsonb, '[]'::jsonb],
  'i dati di un altro utente restano invisibili'
);
reset role;

select is(has_function_privilege('anon', 'public.chart_data(date, date, date)', 'execute'), false, 'anon non può chiamare i dati dei grafici');
select is(
  (select public.chart_data('2026-12-01', '2026-09-01') -> 'months'),
  '[]'::jsonb,
  'un periodo al contrario è vuoto, senza errori'
);

select * from finish();
rollback;
