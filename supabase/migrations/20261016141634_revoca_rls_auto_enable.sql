-- L'opzione "Enable automatic RLS" della dashboard crea public.rls_auto_enable()
-- eseguibile via RPC da anon e authenticated: serve solo al trigger interno.
-- Esiste solo nei progetti creati con quell'opzione, non nello stack locale.
do $$
begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
  end if;
end $$;
