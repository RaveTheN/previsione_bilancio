-- Fondamenta di sicurezza: valgono per tutto ciò che verrà creato dopo.

-- Funzioni interne: schema non esposto dall'API.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

-- Ogni funzione nuova va concessa esplicitamente (Postgres di default la rende eseguibile da tutti).
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;
alter default privileges in schema private revoke execute on functions from public, anon, authenticated;

-- anon non tocca mai le tabelle: entra solo tramite le RPC concesse (es. ingest).
alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke all on sequences from anon;

-- Attività notturna scritta dal job di backup: evita la pausa del progetto Free.
create table private.heartbeat (
  id bigint generated always as identity primary key,
  at timestamptz not null default now()
);
