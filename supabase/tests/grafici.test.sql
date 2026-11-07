-- Dati dei grafici, coerenti con la vista mese. Dati finti.
begin;
create extension if not exists pgtap with schema extensions;
select plan(12);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'a@example.com'),
  ('00000000-0000-0000-0000-00000000000b', 'b@example.com');
insert into public.accounts (id, user_id, name) values
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'Banca');
insert into public.buckets (id, user_id, name, target_pct) values
  ('20000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'Fun', 35);
insert into public.settings (user_id, go_live_month, opening_residual_cents) values
  ('00000000-0000-0000-0000-00000000000a', '2026-09-01', 0);
insert into public.budget_lines (id, user_id, month, name, bucket_id, amount_cents) values
  ('30000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', '2026-10-01', 'Stipendio', null, 200000),
  ('30000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-00000000000a', '2026-10-01', 'Abbonamenti', '20000000-0000-0000-0000-000000000001', -1000);

-- La Rubrica riunisce due nomi della banca sotto un solo esercente.
insert into public.merchants (id, user_id, name) values
  ('40000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'Il Bar');
insert into public.merchant_aliases (user_id, merchant_id, pattern) values
  ('00000000-0000-0000-0000-00000000000a', '40000000-0000-0000-0000-000000000001', 'BAR ESEMPIO SRL'),
  ('00000000-0000-0000-0000-00000000000a', '40000000-0000-0000-0000-000000000001', 'BAR ESEMPIO');
insert into public.merchant_aliases (user_id, pattern, ignored) values
  ('00000000-0000-0000-0000-00000000000a', 'GENERICO PAY', true);

insert into public.transactions
  (user_id, account_id, line_id, amount_cents, booking_date, merchant_raw, status, transfer_group_id) values
  ('00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 200000, '2026-10-01', null, 'confirmed', null),
  ('00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001', null, -1000, '2026-10-02', 'BAR ESEMPIO SRL', 'confirmed', null),
  ('00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001', null, -500, '2026-10-03', 'BAR ESEMPIO', 'confirmed', null),
  -- Reso: si sottrae allo stesso esercente.
  ('00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001', null, 200, '2026-10-04', 'BAR ESEMPIO', 'confirmed', null),
  -- Senza Rubrica: vale il nome della banca, ripulito.
  ('00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001', null, -4000, '2026-10-05', 'SUMUP *NEGOZIO', 'confirmed', null),
  -- Fuori dalla classifica: operazione generica, nome ignorato, rifiutato, trasferimento, mese futuro, solo entrate.
  ('00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001', null, -9000, '2026-10-06', 'BONIFICO ESEGUITO', 'confirmed', null),
  ('00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001', null, -9000, '2026-10-07', 'GENERICO PAY', 'confirmed', null),
  ('00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001', null, -9000, '2026-10-08', 'RIFIUTATO', 'declined', null),
  ('00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001', null, -9000, '2026-10-09', 'GIROCONTO', 'confirmed', '70000000-0000-0000-0000-000000000001'),
  ('00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001', null, -9000, '2026-12-09', 'FUTURO', 'confirmed', null),
  ('00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001', null, 9000, '2026-10-10', 'RIMBORSO', 'confirmed', null),
  -- Una spesa assegnata a una riga, senza nome di esercente.
  ('00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000002', -1100, '2026-10-05', null, 'confirmed', null);

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
  (select sum((s ->> 'cents')::bigint) from risultato, jsonb_array_elements(d -> 'spending') s where s ->> 'bucket_id' is not null),
  (select -sum((m ->> 'expense_actual')::bigint + (m ->> 'saving_actual')::bigint)
   from risultato, jsonb_array_elements(d -> 'months') m where m ->> 'month' <= '2026-11-01'),
  'le fette dei secchi sommano esattamente le uscite della vista mese, fino al mese in corso'
);
select bag_eq(
  $$ select s ->> 'bucket_id' as secchio, s ->> 'line' as riga, s ->> 'merchant' as esercente, (s ->> 'cents')::bigint as centesimi
     from risultato, jsonb_array_elements(d -> 'spending') s $$,
  $$ values
       (null, null, 'Il Bar', 1500::bigint),
       (null, null, 'NEGOZIO', 4000::bigint),
       (null, null, null, 18000::bigint),
       ('20000000-0000-0000-0000-000000000001', 'Abbonamenti', null, 1100::bigint) $$,
  'per secchio, riga ed esercente: da assegnare solo le uscite; fuori rifiutati, trasferimenti, entrate e mesi futuri'
);
select is(
  (select count(*) from risultato, jsonb_array_elements(d -> 'spending') s where s ->> 'line' = 'Stipendio'),
  0::bigint,
  'una riga di entrata non è una fetta'
);

-- Un altro utente non vede nulla.
select set_config('request.jwt.claims', '{"sub": "00000000-0000-0000-0000-00000000000b", "role": "authenticated"}', true);
select is(
  (select array[d -> 'merchants', d -> 'spending'] from (select public.chart_data('2026-09-01', '2026-12-01', '2026-11-15') as d) x),
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
