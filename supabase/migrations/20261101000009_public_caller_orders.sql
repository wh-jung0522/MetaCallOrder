-- Orders placed by phone appear on the public boards, so a demo can show them arriving. Those callers are auto-created
-- with a demo address, so only the last four digits of their number identify them. Their calls and full numbers stay private.
alter table public.customers add column auto_created boolean not null default false;
alter table public.customers add column phone_last4 text generated always as (right(phone_e164, 4)) stored;

update public.customers set auto_created = true where not is_demo and name = '고객' and default_address = '행복동 12번지';

grant select (phone_last4) on public.customers to anon, authenticated;
-- The order policies read this column as anon.
grant select (auto_created) on public.customers to anon;

drop policy customers_public_demo on public.customers;
create policy customers_public_demo on public.customers for select to anon
  using (is_demo or auto_created);

drop policy orders_public_demo on public.orders;
create policy orders_public_demo on public.orders for select to anon
  using (exists (select 1 from public.customers c where c.id = orders.customer_id and (c.is_demo or c.auto_created)));

drop policy orders_public_demo_status on public.orders;
create policy orders_public_demo_status on public.orders for update to anon
  using (status in ('pending', 'accepted') and exists (select 1 from public.customers c where c.id = orders.customer_id and (c.is_demo or c.auto_created)))
  with check (status in ('accepted', 'rejected', 'cancelled') and exists (select 1 from public.customers c where c.id = orders.customer_id and (c.is_demo or c.auto_created)));
