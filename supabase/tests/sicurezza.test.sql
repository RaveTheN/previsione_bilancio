-- Controlli strutturali: proteggono anche le tabelle e le funzioni delle fasi successive.
begin;
create extension if not exists pgtap with schema extensions;
select plan(4);

select is(
  (select count(*) from pg_tables where schemaname = 'public' and not rowsecurity),
  0::bigint,
  'RLS attiva su tutte le tabelle di public'
);

select is(
  (select count(*) from information_schema.role_table_grants
    where grantee = 'anon' and table_schema = 'public'),
  0::bigint,
  'anon non ha privilegi sulle tabelle di public'
);

-- Unica eccezione futura ammessa: ingest (Fase 3).
select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname <> 'ingest'
      and has_function_privilege('anon', p.oid, 'EXECUTE')),
  0::bigint,
  'anon non può eseguire funzioni di public, salvo ingest'
);

select ok(
  not has_schema_privilege('anon', 'private', 'USAGE')
    and not has_schema_privilege('authenticated', 'private', 'USAGE'),
  'lo schema private non è accessibile da anon e authenticated'
);

select * from finish();
rollback;
