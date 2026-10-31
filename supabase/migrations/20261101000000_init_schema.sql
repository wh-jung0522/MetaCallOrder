create table public.customers (
  id uuid primary key default gen_random_uuid(),
  phone_e164 text not null unique,
  name text not null,
  default_address text not null,
  lat double precision,
  lng double precision,
  dietary_notes text,
  order_spend_limit integer not null default 50000,
  daily_spend_limit integer not null default 100000,
  preferred_speech_rate real not null default 0.9,
  is_demo boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.guardians (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  name text not null,
  phone_e164 text not null,
  notify_on_order boolean not null default true
);
create index guardians_customer_id_idx on public.guardians(customer_id);
create index guardians_user_id_idx on public.guardians(user_id);

create table public.stores (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid references auth.users(id) on delete set null,
  name text not null,
  phone_e164 text not null,
  address text not null,
  lat double precision,
  lng double precision,
  adapter_type text not null default 'dashboard' check (adapter_type in ('dashboard', 'webhook')),
  adapter_config jsonb not null default '{}',
  is_open boolean not null default true,
  delivery_fee integer not null default 0,
  min_order_amount integer not null default 0,
  eta_minutes integer not null default 40
);
create index stores_owner_user_id_idx on public.stores(owner_user_id);

create table public.menu_items (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  name text not null,
  aliases text[] not null default '{}',
  price integer not null check (price >= 0),
  options jsonb not null default '[]',
  is_available boolean not null default true
);
create index menu_items_store_id_idx on public.menu_items(store_id);

create table public.calls (
  call_sid text primary key,
  customer_id uuid references public.customers(id) on delete set null,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  outcome text,
  transcript jsonb,
  latency_metrics jsonb,
  cost_usd numeric(10, 5),
  handoff_reason text
);
create index calls_customer_id_idx on public.calls(customer_id);

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id),
  store_id uuid not null references public.stores(id),
  call_sid text,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'rejected', 'cancelled')),
  total integer not null check (total >= 0),
  items jsonb not null,
  delivery_address text not null,
  idempotency_key text not null unique,
  created_at timestamptz not null default now()
);
create index orders_customer_id_idx on public.orders(customer_id, created_at desc);
create index orders_store_id_idx on public.orders(store_id, created_at desc);

create table public.consents (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  type text not null check (type in ('recording', 'ai_processing', 'guardian_share')),
  granted_at timestamptz not null default now(),
  channel text not null
);
create index consents_customer_id_idx on public.consents(customer_id);

alter table public.customers enable row level security;
alter table public.guardians enable row level security;
alter table public.stores enable row level security;
alter table public.menu_items enable row level security;
alter table public.calls enable row level security;
alter table public.orders enable row level security;
alter table public.consents enable row level security;

-- The Worker uses the service role, which bypasses RLS. These policies cover browser users only.
create function public.is_admin() returns boolean
language sql stable set search_path = '' as $$
  select coalesce((select auth.jwt()) -> 'app_metadata' ->> 'role' = 'admin', false)
$$;

-- security definer breaks the guardians <-> customers policy recursion
create function public.is_guardian_of(target uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.guardians g
    where g.customer_id = target and g.user_id = (select auth.uid())
  )
$$;

create function public.owns_store(target uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.stores s
    where s.id = target and s.owner_user_id = (select auth.uid())
  )
$$;

revoke execute on function public.is_guardian_of(uuid), public.owns_store(uuid) from public, anon;
grant execute on function public.is_guardian_of(uuid), public.owns_store(uuid) to authenticated;

create policy customers_select on public.customers for select to authenticated
  using (public.is_guardian_of(id) or public.is_admin());
create policy guardians_select on public.guardians for select to authenticated
  using (user_id = (select auth.uid()) or public.is_admin());
create policy stores_select on public.stores for select to authenticated
  using (true);
create policy menu_items_select on public.menu_items for select to authenticated
  using (true);
create policy calls_select on public.calls for select to authenticated
  using (public.is_admin());
create policy consents_select on public.consents for select to authenticated
  using (public.is_guardian_of(customer_id) or public.is_admin());
create policy orders_select on public.orders for select to authenticated
  using (public.owns_store(store_id) or public.is_guardian_of(customer_id) or public.is_admin());

-- Browsers may change only orders.status: merchants accept or reject, guardians cancel
revoke insert, update, delete on public.orders from anon, authenticated;
grant update (status) on public.orders to authenticated;
create policy orders_merchant_update on public.orders for update to authenticated
  using (public.owns_store(store_id) and status = 'pending')
  with check (public.owns_store(store_id) and status in ('accepted', 'rejected'));
create policy orders_guardian_cancel on public.orders for update to authenticated
  using (public.is_guardian_of(customer_id) and status in ('pending', 'accepted'))
  with check (public.is_guardian_of(customer_id) and status = 'cancelled');

alter publication supabase_realtime add table public.orders;
-- Realtime UPDATE payloads must carry the columns the dashboards render
alter table public.orders replica identity full;
