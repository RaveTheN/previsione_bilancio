-- Fase 2: previsione, catena dei residui, secchi, risparmio e trasferimenti.
-- Dati finti. "Oggi" è fissato con p_today, così i test non scadono.
begin;
create extension if not exists pgtap with schema extensions;
select plan(25);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'a@example.com'),
  ('00000000-0000-0000-0000-00000000000b', 'b@example.com');

insert into public.accounts (id, user_id, name, role, balance_cents, balance_date) values
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'Conto', 'spendable', null, null),
  ('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-00000000000a', 'Altro', 'spendable', null, null),
  -- Saldo di riferimento a fine novembre: comprende già l'accantonamento di novembre.
  ('10000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-00000000000a', 'Salvadanaio', 'reserve', 125000, '2026-11-30'),
  ('10000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-00000000000b', 'Conto B', 'spendable', null, null);
insert into public.buckets (id, user_id, name, sort_order, target_pct) values
  ('20000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'Future me', 1, 15),
  ('20000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-00000000000a', 'Fundamentals', 2, 50),
  ('20000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-00000000000a', 'Fun', 3, 35);
insert into public.categories (id, user_id, name, kind, is_salary, sort_order) values
  ('30000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'Stipendio', 'income', true, 1),
  ('30000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-00000000000a', 'Extra', 'income', false, 2),
  ('30000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-00000000000a', 'Risparmio', 'saving', false, 3),
  ('30000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-00000000000a', 'Affitto', 'expense', false, 4),
  ('30000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-00000000000a', 'Spesa', 'expense', false, 5);
insert into public.settings (user_id, go_live_month, opening_residual_cents, savings_pct, savings_bucket_id) values
  ('00000000-0000-0000-0000-00000000000a', '2026-11-01', 100000, 15, '20000000-0000-0000-0000-000000000001');

-- Previsione. Novembre è costruito come il gennaio 2024 del vecchio foglio:
-- stipendio, un'entrata extra, spese in due secchi e il risparmio predefinito (15%).
insert into public.budget_lines (user_id, month, category_id, bucket_id, amount_cents)
select '00000000-0000-0000-0000-00000000000a', m::date, ('30000000-0000-0000-0000-00000000000' || c)::uuid,
  ('20000000-0000-0000-0000-00000000000' || b)::uuid, amt
from (values
  ('2026-11-01', '1', null, 200000), ('2026-11-01', '2', null, 10000),
  ('2026-11-01', '4', '2', -50000), ('2026-11-01', '5', '2', -30000), ('2026-11-01', '5', '3', -20000),
  ('2026-12-01', '1', null, 200000), ('2026-12-01', '4', '2', -50000),
  -- gennaio: risparmio scritto a zero, quindi il predefinito non vale
  ('2027-01-01', '1', null, 200000), ('2027-01-01', '4', '2', -50000), ('2027-01-01', '3', '1', 0),
  ('2027-02-01', '1', null, 200000), ('2027-02-01', '4', '2', -50000), ('2027-02-01', '5', '2', -40000),
  -- marzo senza previsione; aprile senza stipendio
  ('2027-04-01', '4', '2', -50000),
  -- ottobre è prima dell'avvio: mese storico
  ('2026-10-01', '1', null, 200000)
) as v (m, c, b, amt);

insert into public.transactions (id, user_id, account_id, category_id, bucket_id, amount_cents, booking_date, status)
select coalesce(id::uuid, gen_random_uuid()), '00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001',
  ('30000000-0000-0000-0000-00000000000' || c)::uuid, ('20000000-0000-0000-0000-00000000000' || b)::uuid, amt, d::date, st
from (values
  (null, '1', null, 200000, '2026-11-27', 'confirmed'),
  (null, '2', null, 10000, '2026-11-10', 'confirmed'),
  (null, '4', '2', -50000, '2026-11-02', 'confirmed'),
  ('60000000-0000-0000-0000-000000000001', '5', '2', -33000, '2026-11-15', 'confirmed'),
  (null, '5', '3', -15000, '2026-11-18', 'confirmed'),
  (null, '5', '2', -9999, '2026-11-19', 'declined'),
  (null, null, null, -1000, '2026-11-25', 'confirmed'),
  (null, '1', null, 200000, '2026-12-27', 'confirmed'),
  (null, '4', '2', -50000, '2026-12-02', 'confirmed'),
  (null, '5', '3', -80000, '2026-12-20', 'confirmed'),
  (null, '4', '2', -50000, '2027-01-02', 'confirmed')
) as v (id, c, b, amt, d, st);

-- Da qui come utente A.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated"}', true);

-- Trasferimenti: accantonamento (spendibile → riserva), ordinario, prelievo (riserva → spendibile).
select public.create_transfer('50000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000003', 25000, '2026-11-20', 'Accantonamento');
select public.create_transfer('50000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000003', 25000, '2026-11-20', 'Accantonamento');
select public.create_transfer('50000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000002', 5000, '2026-11-21', null);
select public.create_transfer('50000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000003',
  '10000000-0000-0000-0000-000000000001', 7000, '2027-05-10', null);

select is(
  (select count(*) from public.transactions where transfer_group_id = '50000000-0000-0000-0000-000000000001'),
  2::bigint,
  'il trasferimento crea due righe e ripeterlo non crea doppioni'
);
select results_eq(
  $$ select account_id, category_id, bucket_id, amount_cents from public.transactions
     where transfer_group_id = '50000000-0000-0000-0000-000000000001' order by amount_cents $$,
  $$ values ('10000000-0000-0000-0000-000000000001'::uuid, '30000000-0000-0000-0000-000000000003'::uuid,
             '20000000-0000-0000-0000-000000000001'::uuid, -25000::bigint),
            ('10000000-0000-0000-0000-000000000003'::uuid, null, null, 25000::bigint) $$,
  'accantonamento: il lato spendibile è Risparmio nel secchio delle impostazioni, il Salvadanaio no'
);
select is(
  (select count(*) from public.transactions
    where transfer_group_id = '50000000-0000-0000-0000-000000000002' and category_id is null),
  2::bigint,
  'trasferimento ordinario: nessuna categoria su entrambe le righe'
);
select is(
  (select public.month_overview('2027-05-01', '2027-01-15') -> 'saving_actual'),
  '7000'::jsonb,
  'prelievo dal Salvadanaio: risparmio negativo sul lato spendibile'
);
select throws_ok(
  $$ select public.create_transfer(gen_random_uuid(), '10000000-0000-0000-0000-000000000001',
       '10000000-0000-0000-0000-000000000001', 100) $$,
  '22023', 'Scegli due conti diversi',
  'trasferimento verso lo stesso conto rifiutato'
);
select throws_ok(
  $$ select public.create_transfer(gen_random_uuid(), '10000000-0000-0000-0000-000000000001',
       '10000000-0000-0000-0000-000000000003', 0) $$,
  '22023', 'Importo non valido',
  'trasferimento a zero rifiutato'
);

-- Novembre: il mese di prova. Oggi = 15 gennaio 2027.
select is(
  (select jsonb_build_object(
     'in_f', o -> 'income_forecast', 'in_a', o -> 'income_actual',
     'out_f', o -> 'expense_forecast', 'out_a', o -> 'expense_actual',
     'sav_f', o -> 'saving_forecast', 'sav_a', o -> 'saving_actual')
   from public.month_overview('2026-11-01', '2027-01-15') o),
  '{"in_f": 210000, "in_a": 210000, "out_f": -100000, "out_a": -99000, "sav_f": -30000, "sav_a": -25000}'::jsonb,
  'mese di prova: entrate, uscite e risparmio; esclusi rifiutati e trasferimenti ordinari, "Da assegnare" incluso'
);
select is(
  (select jsonb_build_object(
     'start_f', o -> 'start_forecast', 'start_a', o -> 'start_actual',
     'end_f', o -> 'end_forecast', 'end_a', o -> 'end_actual')
   from public.month_overview('2026-11-01', '2027-01-15') o),
  '{"start_f": 100000, "start_a": 100000, "end_f": 180000, "end_a": 186000}'::jsonb,
  'mese di prova: residuo iniziale di apertura e residuo finale previsto/effettivo'
);
select is(
  (select o -> 'buckets' from public.month_overview('2026-11-01', '2027-01-15') o),
  '[{"bucket_id": "20000000-0000-0000-0000-000000000001", "target_pct": 15, "forecast_pct": 15, "actual_pct": 12.5},
    {"bucket_id": "20000000-0000-0000-0000-000000000002", "target_pct": 50, "forecast_pct": 40, "actual_pct": 41.5},
    {"bucket_id": "20000000-0000-0000-0000-000000000003", "target_pct": 35, "forecast_pct": 10, "actual_pct": 7.5}]'::jsonb,
  'percentuali dei secchi sullo stipendio: obiettivo, prevista, reale'
);
select is(
  (select l from public.month_overview('2026-11-01', '2027-01-15') o, jsonb_array_elements(o -> 'lines') l
    where l ->> 'category_id' = '30000000-0000-0000-0000-000000000003'),
  '{"category_id": "30000000-0000-0000-0000-000000000003", "bucket_id": "20000000-0000-0000-0000-000000000001",
    "inflow": null, "forecast": -30000, "actual": -25000, "n": 1, "is_default": true}'::jsonb,
  'risparmio predefinito al 15% dello stipendio previsto; l''accantonamento conta una volta'
);

-- Catena dei residui.
select is(
  (select jsonb_build_object('start_f', o -> 'start_forecast', 'start_a', o -> 'start_actual')
   from public.month_overview('2027-01-01', '2027-01-15') o),
  '{"start_f": 256000, "start_a": 256000}'::jsonb,
  'da dicembre a gennaio il residuo effettivo passa intero (100000 + 86000 + 70000)'
);
select is(
  (select jsonb_build_object(
     'sav_f', o -> 'saving_forecast',
     'future_me', o -> 'buckets' -> 0 -> 'forecast_pct',
     'fundamentals_real', o -> 'buckets' -> 1 -> 'actual_pct')
   from public.month_overview('2027-01-01', '2027-01-15') o),
  '{"sav_f": 0, "future_me": 0, "fundamentals_real": 25}'::jsonb,
  'previsione a zero: vale zero (non il predefinito); senza stipendio reale la base è quello previsto'
);
select is(
  (select array[(f -> 'start_forecast')::bigint, (m -> 'start_forecast')::bigint,
                (m -> 'end_forecast')::bigint, (a -> 'end_forecast')::bigint]
   from public.month_overview('2027-02-01', '2027-01-15') f,
        public.month_overview('2027-03-01', '2027-01-15') m,
        public.month_overview('2027-04-01', '2027-01-15') a),
  array[406000, 486000, 486000, 436000]::bigint[],
  'mesi futuri: la catena prosegue con i netti previsti, anche nei mesi senza previsione'
);
select is(
  (select o -> 'buckets' from public.month_overview('2027-04-01', '2027-01-15') o),
  '[{"bucket_id": "20000000-0000-0000-0000-000000000001", "target_pct": 15, "forecast_pct": null, "actual_pct": null},
    {"bucket_id": "20000000-0000-0000-0000-000000000002", "target_pct": 50, "forecast_pct": null, "actual_pct": null},
    {"bucket_id": "20000000-0000-0000-0000-000000000003", "target_pct": 35, "forecast_pct": null, "actual_pct": null}]'::jsonb,
  'mese senza stipendio: percentuali assenti, nessuna divisione per zero'
);
select is(
  (select public.month_overview('2027-01-01', '2026-11-10') -> 'start_forecast'),
  '300000'::jsonb,
  'con oggi a novembre, dicembre → gennaio passa per la previsione (100000 + 80000 + 120000)'
);
select is(
  (select jsonb_build_object('start', o -> 'start_forecast', 'sav_f', o -> 'saving_forecast')
   from public.month_overview('2026-10-01', '2027-01-15') o),
  '{"start": null, "sav_f": 0}'::jsonb,
  'prima del mese di avvio: niente residuo (catena storica) e niente risparmio predefinito'
);

-- Salvadanaio.
select is(
  (select array[(o -> 'reserve_actual')::bigint, (n -> 'reserve_actual')::bigint,
                (n -> 'reserve_forecast')::bigint, (f -> 'reserve_forecast')::bigint]
   from public.month_overview('2026-10-01', '2027-01-15') o,
        public.month_overview('2026-11-01', '2027-01-15') n,
        public.month_overview('2027-02-01', '2027-01-15') f),
  array[100000, 125000, 130000, 155000]::bigint[],
  'Salvadanaio: ricostruito dal saldo di riferimento; l''accantonamento lo aumenta; previsto con il risparmio previsto'
);

-- Modifiche: una spesa passata e una previsione futura aggiornano i residui successivi.
update public.transactions set amount_cents = -43000 where id = '60000000-0000-0000-0000-000000000001';
select is(
  (select array[(j -> 'start_actual')::bigint, (f -> 'start_forecast')::bigint]
   from public.month_overview('2027-01-01', '2027-01-15') j,
        public.month_overview('2027-02-01', '2027-01-15') f),
  array[246000, 396000]::bigint[],
  'una spesa passata modificata aggiorna i residui dei mesi successivi'
);
update public.budget_lines set amount_cents = -60000
where month = '2027-02-01' and category_id = '30000000-0000-0000-0000-000000000005';
select is(
  (select public.month_overview('2027-03-01', '2027-01-15') -> 'start_forecast'),
  '456000'::jsonb,
  'una previsione modificata aggiorna i residui previsti dei mesi futuri'
);
select throws_ok(
  $$ insert into public.budget_lines (month, category_id, bucket_id, amount_cents)
     values ('2027-02-01', '30000000-0000-0000-0000-000000000005', '20000000-0000-0000-0000-000000000002', -1) $$,
  '23505', null,
  'una sola previsione per mese, categoria e secchio'
);

-- Risparmio come importo fisso: vale in ogni mese pianificato dall'avvio, anche senza stipendio.
update public.settings set savings_amount_cents = 25000;
select is(
  (select array[(n -> 'saving_forecast')::bigint, (a -> 'saving_forecast')::bigint,
                (m -> 'saving_forecast')::bigint, (o -> 'saving_forecast')::bigint]
   from public.month_overview('2026-11-01', '2027-01-15') n,
        public.month_overview('2027-04-01', '2027-01-15') a,
        public.month_overview('2027-03-01', '2027-01-15') m,
        public.month_overview('2026-10-01', '2027-01-15') o),
  array[-25000, -25000, 0, 0]::bigint[],
  'importo fisso: nei mesi pianificati (non in quelli vuoti né prima dell''avvio)'
);

-- Utente B: non vede e non usa i dati di A.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000b","role":"authenticated"}', true);

select is(
  (select count(*) from public.budget_lines) + (select count(*) from public.settings),
  0::bigint,
  'B non vede previsioni e impostazioni di A'
);
select is(
  (select jsonb_build_object('lines', o -> 'lines', 'start', o -> 'start_forecast')
   from public.month_overview('2026-11-01', '2027-01-15') o),
  '{"lines": [], "start": null}'::jsonb,
  'la vista del mese di B è vuota'
);
select throws_ok(
  $$ insert into public.budget_lines (month, category_id, amount_cents)
     values ('2026-11-01', '30000000-0000-0000-0000-000000000001', 100) $$,
  '23503', null,
  'B non può prevedere su una categoria di A (FK composta)'
);
select throws_ok(
  $$ select public.create_transfer(gen_random_uuid(), '10000000-0000-0000-0000-000000000001',
       '10000000-0000-0000-0000-000000000003', 100) $$,
  '22023', 'Scegli due conti diversi',
  'B non può trasferire tra i conti di A'
);

select * from finish();
rollback;
