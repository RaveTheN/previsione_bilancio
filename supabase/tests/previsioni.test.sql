-- Previsione per righe, catena dei residui, secchi, risparmio e trasferimenti.
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
insert into public.settings (user_id, go_live_month, opening_residual_cents, savings_bucket_id) values
  ('00000000-0000-0000-0000-00000000000a', '2026-11-01', 100000, '20000000-0000-0000-0000-000000000001');

-- Righe del mese: nome, secchio (vuoto per le entrate), previsto.
insert into public.budget_lines (user_id, month, name, bucket_id, amount_cents)
select '00000000-0000-0000-0000-00000000000a', m::date, n, ('20000000-0000-0000-0000-00000000000' || b)::uuid, amt
from (values
  ('2026-11-01', 'Stipendio', null, 200000), ('2026-11-01', 'Extra', null, 10000),
  ('2026-11-01', 'Affitto', '2', -50000), ('2026-11-01', 'Spesa', '2', -30000), ('2026-11-01', 'Svago', '3', -20000),
  ('2026-11-01', 'Risparmio', '1', -30000),
  ('2026-12-01', 'Stipendio', null, 200000), ('2026-12-01', 'Affitto', '2', -50000), ('2026-12-01', 'Svago', '3', 0),
  ('2027-01-01', 'Stipendio', null, 200000), ('2027-01-01', 'Affitto', '2', -50000), ('2027-01-01', 'Risparmio', '1', 0),
  ('2027-02-01', 'Stipendio', null, 200000), ('2027-02-01', 'Affitto', '2', -50000), ('2027-02-01', 'Spesa', '2', -40000),
  -- marzo senza righe; aprile senza stipendio
  ('2027-04-01', 'Affitto', '2', -50000),
  -- ottobre è prima dell'avvio: mese storico
  ('2026-10-01', 'Stipendio', null, 200000)
) as v (m, n, b, amt);

insert into public.transactions (id, user_id, account_id, line_id, amount_cents, booking_date, status)
select coalesce(id::uuid, gen_random_uuid()), '00000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001',
  (select b.id from public.budget_lines b
    where b.user_id = '00000000-0000-0000-0000-00000000000a' and b.name = v.n and b.month = date_trunc('month', v.d::date)::date),
  amt, d::date, st
from (values
  (null, 'Stipendio', 200000, '2026-11-27', 'confirmed'),
  (null, 'Extra', 10000, '2026-11-10', 'confirmed'),
  (null, 'Affitto', -50000, '2026-11-02', 'confirmed'),
  ('60000000-0000-0000-0000-000000000001', 'Spesa', -33000, '2026-11-15', 'confirmed'),
  (null, 'Svago', -15000, '2026-11-18', 'confirmed'),
  (null, 'Spesa', -9999, '2026-11-19', 'declined'),
  (null, null, -1000, '2026-11-25', 'confirmed'),
  (null, 'Stipendio', 200000, '2026-12-27', 'confirmed'),
  (null, 'Affitto', -50000, '2026-12-02', 'confirmed'),
  (null, 'Svago', -80000, '2026-12-20', 'confirmed'),
  (null, 'Affitto', -50000, '2027-01-02', 'confirmed')
) as v (id, n, amt, d, st);

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
  $$ select t.account_id, b.name, t.amount_cents from public.transactions t
     left join public.budget_lines b on b.id = t.line_id
     where t.transfer_group_id = '50000000-0000-0000-0000-000000000001' order by t.amount_cents $$,
  $$ values ('10000000-0000-0000-0000-000000000001'::uuid, 'Risparmio', -25000::bigint),
            ('10000000-0000-0000-0000-000000000003'::uuid, null, 25000::bigint) $$,
  'accantonamento: il lato spendibile va sulla riga Risparmio del mese, il Salvadanaio no'
);
select is(
  (select count(*) from public.transactions
    where transfer_group_id = '50000000-0000-0000-0000-000000000002' and line_id is null),
  2::bigint,
  'trasferimento ordinario: nessuna riga su entrambi i lati'
);
select is(
  (select public.month_overview('2027-05-01', '2027-01-15') -> 'saving_actual'),
  '7000'::jsonb,
  'prelievo dal Salvadanaio: la riga Risparmio si crea se manca, con il risparmio negativo'
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
     'sav_f', o -> 'saving_forecast', 'sav_a', o -> 'saving_actual',
     'unassigned', o -> 'unassigned')
   from public.month_overview('2026-11-01', '2027-01-15') o),
  '{"in_f": 210000, "in_a": 210000, "out_f": -100000, "out_a": -98000, "sav_f": -30000, "sav_a": -25000,
    "unassigned": {"actual": -1000, "n": 1}}'::jsonb,
  'mese di prova: entrate, uscite e risparmio; esclusi rifiutati e trasferimenti ordinari; "Da assegnare" a parte'
);
select is(
  (select jsonb_build_object(
     'start_f', o -> 'start_forecast', 'start_a', o -> 'start_actual',
     'end_f', o -> 'end_forecast', 'end_a', o -> 'end_actual')
   from public.month_overview('2026-11-01', '2027-01-15') o),
  '{"start_f": 100000, "start_a": 100000, "end_f": 180000, "end_a": 186000}'::jsonb,
  'mese di prova: residuo iniziale di apertura e residuo finale previsto/effettivo, "Da assegnare" compreso'
);
select is(
  (select o -> 'buckets' from public.month_overview('2026-11-01', '2027-01-15') o),
  '[{"bucket_id": "20000000-0000-0000-0000-000000000001", "target_pct": 15, "forecast_pct": 14.3, "actual_pct": 11.9},
    {"bucket_id": "20000000-0000-0000-0000-000000000002", "target_pct": 50, "forecast_pct": 38.1, "actual_pct": 39.5},
    {"bucket_id": "20000000-0000-0000-0000-000000000003", "target_pct": 35, "forecast_pct": 9.5, "actual_pct": 7.1}]'::jsonb,
  'percentuali dei secchi sul totale delle entrate: obiettivo, prevista, reale'
);
select is(
  (select l - 'id' from public.month_overview('2026-11-01', '2027-01-15') o, jsonb_array_elements(o -> 'lines') l
    where l ->> 'name' = 'Risparmio'),
  '{"name": "Risparmio", "bucket_id": "20000000-0000-0000-0000-000000000001", "sort_order": 0,
    "over_is_good": true, "forecast": -30000, "actual": -25000, "n": 1}'::jsonb,
  'la riga Risparmio: previsto scritto, l''accantonamento conta una volta'
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
  'risparmio scritto a zero vale zero; senza entrate reali la base è quella prevista'
);
select is(
  (select array[(f -> 'start_forecast')::bigint, (m -> 'start_forecast')::bigint,
                (m -> 'end_forecast')::bigint, (a -> 'end_forecast')::bigint]
   from public.month_overview('2027-02-01', '2027-01-15') f,
        public.month_overview('2027-03-01', '2027-01-15') m,
        public.month_overview('2027-04-01', '2027-01-15') a),
  array[406000, 516000, 516000, 466000]::bigint[],
  'mesi futuri: la catena prosegue con i netti previsti, anche nei mesi senza righe'
);
select is(
  (select o -> 'buckets' from public.month_overview('2027-04-01', '2027-01-15') o),
  '[{"bucket_id": "20000000-0000-0000-0000-000000000001", "target_pct": 15, "forecast_pct": null, "actual_pct": null},
    {"bucket_id": "20000000-0000-0000-0000-000000000002", "target_pct": 50, "forecast_pct": null, "actual_pct": null},
    {"bucket_id": "20000000-0000-0000-0000-000000000003", "target_pct": 35, "forecast_pct": null, "actual_pct": null}]'::jsonb,
  'mese senza entrate: percentuali assenti, nessuna divisione per zero'
);
select is(
  (select public.month_overview('2027-01-01', '2026-11-10') -> 'start_forecast'),
  '330000'::jsonb,
  'con oggi a novembre, dicembre → gennaio passa per la previsione (100000 + 80000 + 150000)'
);
select is(
  (select jsonb_build_object('start', o -> 'start_forecast', 'sav_f', o -> 'saving_forecast')
   from public.month_overview('2026-10-01', '2027-01-15') o),
  '{"start": null, "sav_f": 0}'::jsonb,
  'prima del mese di avvio: niente residuo (catena storica)'
);

-- Salvadanaio.
select is(
  (select array[(o -> 'reserve_actual')::bigint, (n -> 'reserve_actual')::bigint,
                (n -> 'reserve_forecast')::bigint, (f -> 'reserve_forecast')::bigint]
   from public.month_overview('2026-10-01', '2027-01-15') o,
        public.month_overview('2026-11-01', '2027-01-15') n,
        public.month_overview('2027-02-01', '2027-01-15') f),
  array[100000, 125000, 130000, 125000]::bigint[],
  'Salvadanaio: ricostruito dal saldo di riferimento; l''accantonamento lo aumenta; previsto con le righe Risparmio'
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
update public.budget_lines set amount_cents = -60000 where month = '2027-02-01' and name = 'Spesa';
select is(
  (select public.month_overview('2027-03-01', '2027-01-15') -> 'start_forecast'),
  '486000'::jsonb,
  'una previsione modificata aggiorna i residui previsti dei mesi futuri'
);
select throws_ok(
  $$ insert into public.budget_lines (month, name, bucket_id, amount_cents)
     values ('2027-02-01', 'Spesa', '20000000-0000-0000-0000-000000000003', -1) $$,
  '23505', null,
  'una sola riga con lo stesso nome nel mese'
);

-- Griglia annuale: dodici mesi, ognuno uguale alla vista mese.
select is(
  (select array[jsonb_array_length(g)::bigint, (g -> 1 = public.month_overview('2027-02-01', '2027-01-15'))::int]
   from public.year_grid(2027, '2027-01-15') g),
  array[12, 1]::bigint[],
  'la griglia ha 12 mesi e ogni mese coincide con la vista mese'
);

-- Utente B: non vede e non usa i dati di A.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000b","role":"authenticated"}', true);

select is(
  (select count(*) from public.budget_lines) + (select count(*) from public.settings),
  0::bigint,
  'B non vede righe e impostazioni di A'
);
select is(
  (select jsonb_build_object('lines', o -> 'lines', 'start', o -> 'start_forecast')
   from public.month_overview('2026-11-01', '2027-01-15') o),
  '{"lines": [], "start": null}'::jsonb,
  'la vista del mese di B è vuota'
);
select throws_ok(
  $$ insert into public.budget_lines (month, name, bucket_id, amount_cents)
     values ('2026-11-01', 'X', '20000000-0000-0000-0000-000000000001', 100) $$,
  '23503', null,
  'B non può usare un secchio di A (FK composta)'
);
select throws_ok(
  $$ select public.create_transfer(gen_random_uuid(), '10000000-0000-0000-0000-000000000001',
       '10000000-0000-0000-0000-000000000003', 100) $$,
  '22023', 'Scegli due conti diversi',
  'B non può trasferire tra i conti di A'
);

select * from finish();
rollback;
