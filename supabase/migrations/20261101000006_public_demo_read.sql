-- The guardian and admin screens open without a login, but only ever show demo data. Rows of a customer with
-- is_demo = false stay out of reach of anon, and the policies are for anon alone so that a logged-in merchant or
-- guardian does not get demo rows mixed into their own board.
-- No SECURITY DEFINER is needed: anon reads customers through its own policy, which already limits it to demo rows.

-- A call whose customer row was deleted gets customer_id null (on delete set null). Without this column a real
-- phone call would then look like an unregistered simulator call and turn public.
alter table public.calls add column channel text check (channel in ('simulator', 'phone'));

-- Supabase's default privileges gave anon everything here, with RLS as the only barrier. Grants are now column by
-- column, so select=* fails for anon and any column added later starts out hidden.
revoke all on public.customers, public.guardians, public.consents, public.calls, public.orders from anon;

-- No phone number, address or spending limit. guardians and consents get nothing at all.
grant select (id, name, is_demo) on public.customers to anon;
-- No idempotency_key or call_sid, which link an order to a call and its logs.
grant select (id, customer_id, store_id, status, total, items, delivery_address, created_at) on public.orders to anon;
-- No handoff_reason, which can carry raw provider error text. No channel, which the screens have no use for.
grant select (call_sid, customer_id, started_at, ended_at, outcome, transcript, latency_metrics, cost_usd) on public.calls to anon;

create policy customers_public_demo on public.customers for select to anon
  using (is_demo);
create policy orders_public_demo on public.orders for select to anon
  using (exists (select 1 from public.customers c where c.id = orders.customer_id and c.is_demo));
create policy calls_public_demo on public.calls for select to anon
  using (
    (customer_id is null and channel is distinct from 'phone')
    or exists (select 1 from public.customers c where c.id = calls.customer_id and c.is_demo)
  );
