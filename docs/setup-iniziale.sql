-- Configurazione iniziale: secchi, categorie e conti dell'unico utente.
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

insert into public.categories (user_id, name, kind, is_salary, sort_order)
select u.id, c.name, c.kind, c.name = 'Stipendio', c.ord
from auth.users u,
  (values
    ('Stipendio', 'income', 1),
    ('Tredicesima', 'income', 2),
    ('Interessi', 'income', 3),
    ('Vinted', 'income', 4),
    ('Altre vendite', 'income', 5),
    ('Entrate straordinarie', 'income', 6),
    ('Finanziamenti', 'income', 7),
    ('Risparmio', 'saving', 10),
    ('Affitto', 'expense', 20),
    ('Utenze', 'expense', 21),
    ('Telefono e internet', 'expense', 22),
    ('Garage', 'expense', 23),
    ('Spesa', 'expense', 24),
    ('Salute', 'expense', 25),
    ('Cura personale', 'expense', 26),
    ('Contanti', 'expense', 27),
    ('Trasporti', 'expense', 28),
    ('Carburante', 'expense', 29),
    ('Moto/auto', 'expense', 30),
    ('Servizi digitali', 'expense', 31),
    ('Streaming', 'expense', 32),
    ('Rate e prestiti', 'expense', 33),
    ('Uscite e ristoranti', 'expense', 34),
    ('Acquisti', 'expense', 35),
    ('Musica e strumenti', 'expense', 36),
    ('Viaggi ed eventi', 'expense', 37),
    ('Regali fatti', 'expense', 38)
  ) as c (name, kind, ord)
on conflict do nothing;

insert into public.accounts (user_id, name, role, sort_order)
select u.id, a.name, a.role, a.ord
from auth.users u,
  (values ('BBVA', 'spendable', 1), ('Salvadanaio', 'reserve', 2)) as a (name, role, ord)
on conflict do nothing;
