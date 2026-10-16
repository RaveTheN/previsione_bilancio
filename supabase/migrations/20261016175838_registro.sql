-- Fase 1: registro dei movimenti.
-- Ogni tabella ha (id, user_id) unico, così le FK composte impediscono
-- di collegare dati di utenti diversi.

create table public.buckets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  name text not null,
  sort_order int not null default 0,
  target_pct numeric(5, 2) not null default 0,
  created_at timestamptz not null default now(),
  unique (id, user_id)
);
create unique index buckets_name_uq on public.buckets (user_id, lower(name));

create table public.categories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  name text not null,
  kind text not null check (kind in ('income', 'expense', 'saving')),
  is_salary boolean not null default false,
  sort_order int not null default 0,
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  unique (id, user_id)
);
create unique index categories_name_uq on public.categories (user_id, lower(name));

create table public.accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  name text not null,
  role text not null default 'spendable' check (role in ('spendable', 'reserve')),
  -- Saldo di riferimento dichiarato dall'utente, con la sua data.
  balance_cents bigint,
  balance_date date,
  sort_order int not null default 0,
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  unique (id, user_id)
);
create unique index accounts_name_uq on public.accounts (user_id, lower(name));

create table public.transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  account_id uuid not null,
  category_id uuid,
  bucket_id uuid,
  -- Centesimi con segno: entrate positive, uscite e accantonamenti negativi.
  amount_cents bigint not null check (amount_cents <> 0),
  occurred_at timestamptz not null default now(),
  -- Decide il mese: colonna "Data" dell'estratto, oppure il giorno locale.
  booking_date date not null default (now() at time zone 'Europe/Rome')::date,
  value_date date,
  month date generated always as (date_trunc('month', booking_date::timestamp)::date) stored,
  merchant_raw text,
  note text,
  source text not null default 'manual' check (source in ('manual', 'wallet', 'notification', 'recurring', 'import')),
  status text not null default 'confirmed' check (status in ('confirmed', 'pending', 'declined')),
  review_reason text,
  -- Le due righe di un trasferimento condividono lo stesso gruppo.
  transfer_group_id uuid,
  created_at timestamptz not null default now(),
  unique (id, user_id),
  foreign key (account_id, user_id) references public.accounts (id, user_id),
  foreign key (category_id, user_id) references public.categories (id, user_id),
  foreign key (bucket_id, user_id) references public.buckets (id, user_id)
);
create index transactions_month_idx on public.transactions (user_id, month, booking_date desc);

create table public.tags (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  unique (id, user_id)
);
create unique index tags_name_uq on public.tags (user_id, lower(name));

create table public.transaction_tags (
  transaction_id uuid not null,
  tag_id uuid not null,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  primary key (transaction_id, tag_id),
  foreign key (transaction_id, user_id) references public.transactions (id, user_id) on delete cascade,
  foreign key (tag_id, user_id) references public.tags (id, user_id) on delete cascade
);

-- RLS: ognuno vede e scrive solo i propri dati.
alter table public.buckets enable row level security;
alter table public.categories enable row level security;
alter table public.accounts enable row level security;
alter table public.transactions enable row level security;
alter table public.tags enable row level security;
alter table public.transaction_tags enable row level security;

create policy "solo i propri dati" on public.buckets for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "solo i propri dati" on public.categories for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "solo i propri dati" on public.accounts for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "solo i propri dati" on public.transactions for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "solo i propri dati" on public.tags for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "solo i propri dati" on public.transaction_tags for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- Effettivo del mese per categoria, secchio e verso (entrata/uscita).
-- Contano tutti i movimenti non rifiutati, tranne i trasferimenti ordinari
-- (righe di trasferimento senza categoria). Le righe senza categoria o senza
-- secchio sono la parte "Da assegnare"; il verso evita di compensare tra loro
-- entrate e uscite non ancora classificate.
create view public.month_actuals with (security_invoker = true) as
select
  user_id,
  month,
  category_id,
  bucket_id,
  amount_cents > 0 as inflow,
  sum(amount_cents)::bigint as actual_cents,
  count(*)::int as n
from public.transactions
where status <> 'declined'
  and (transfer_group_id is null or category_id is not null)
group by user_id, month, category_id, bucket_id, amount_cents > 0;
