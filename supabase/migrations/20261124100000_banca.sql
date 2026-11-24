-- Collegamento con la banca (Enable Banking): la sessione autorizzata, una per utente.
-- La scrive l'utente dallo SQL Editor, con il file generato da tools/banca-consenso.mjs.
-- La legge la funzione "banca" con il token di chi la chiama: è la RLS a decidere di chi sono
-- i dati. Senza la chiave privata dell'applicazione, che sta solo nei segreti della funzione,
-- la sessione non dà accesso a nulla.
create table public.bank_links (
  user_id uuid primary key default auth.uid() references auth.users on delete cascade,
  session_id text not null,
  updated_at timestamptz not null default now()
);
alter table public.bank_links enable row level security;
create policy "solo i propri dati" on public.bank_links for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
