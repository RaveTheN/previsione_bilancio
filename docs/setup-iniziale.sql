-- Configurazione iniziale: secchi e conti dell'unico utente.
-- Da eseguire una volta nello SQL Editor di Supabase (per lo stack locale: in Studio).
-- Si può rieseguire: non crea doppioni.

do $$
begin
  if (select count(*) from auth.users) <> 1 then
    raise exception 'Atteso esattamente un utente, trovati %', (select count(*) from auth.users);
  end if;
end $$;

insert into public.buckets (user_id, name, sort_order, target_pct)
select u.id, b.name, b.ord, b.pct
from auth.users u,
  (values ('Future me', 1, 15), ('Fundamentals', 2, 50), ('Fun', 3, 35)) as b (name, ord, pct)
on conflict do nothing;

insert into public.accounts (user_id, name, role, sort_order)
select u.id, a.name, a.role, a.ord
from auth.users u,
  (values ('BBVA', 'spendable', 1), ('Salvadanaio', 'reserve', 2)) as a (name, role, ord)
on conflict do nothing;

-- Regole delle notifiche BBVA (Fase 3), scritte sui testi reali dello spike:
--   "Pagamento accettato 👍💳Pagamento di 12,00 EUR presso NEGOZIO effettuato con la tua carta *1234"
--   "Puoi rateizzare questo acquisto da 48,30 EUR presso NEGOZIO con la tua carta *1234. Simula le rate."
insert into public.parse_rules (user_id, app, priority, match_regex, action, amount_regex, merchant_regex, card_regex)
select u.id, 'BBVA', r.priority, r.match_regex, 'expense', '([0-9][0-9.,]*)\s*EUR', r.merchant_regex, 'carta\s+\*+(\d{4})'
from auth.users u,
  (values
    (1, 'Pagamento accettato', 'presso\s+(.+?)\s+effettuato con'),
    (2, 'rateizzare questo acquisto', 'presso\s+(.+?)\s+con la tua carta')
  ) as r (priority, match_regex, merchant_regex)
where not exists (
  select from public.parse_rules p where p.user_id = u.id and p.app = 'BBVA' and p.match_regex = r.match_regex
);

-- Regole delle notifiche PayPal (Fase 6), in inglese e senza carta: vale il primo conto spendibile.
--   "You sent €5.00 EUR to Mario Rossi"
--   "Your purchase at NEGOZIO" + "Your €4,99 EUR payment was completed. Tap for more details."
--   "Your purchase at NEGOZIO" + "You authorized a payment of €19,40 EUR. Tap for more details."
insert into public.parse_rules (user_id, app, priority, match_regex, action, amount_regex, merchant_regex)
select u.id, 'PayPal', r.priority, r.match_regex, r.action, '€\s*([0-9][0-9.,]*)', r.merchant_regex
from auth.users u,
  (values
    (1, 'You sent', 'expense', 'You sent \S+ EUR to ([^\n]+)'),
    (2, 'payment was completed', 'expense', 'Your purchase at ([^\n]+)'),
    (3, 'You authorized a payment', 'authorized', 'Your purchase at ([^\n]+)')
  ) as r (priority, match_regex, action, merchant_regex)
where not exists (
  select from public.parse_rules p where p.user_id = u.id and p.app = 'PayPal' and p.match_regex = r.match_regex
);
