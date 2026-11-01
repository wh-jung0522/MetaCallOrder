-- The order board and the guardian screen also act without a login: anyone may accept, decline or cancel a demo order.
-- Real customers' orders stay out of reach, and the status column is the only thing anon can write.
grant update (status) on public.orders to anon;

create policy orders_public_demo_status on public.orders for update to anon
  using (status in ('pending', 'accepted') and exists (select 1 from public.customers c where c.id = orders.customer_id and c.is_demo))
  with check (status in ('accepted', 'rejected', 'cancelled') and exists (select 1 from public.customers c where c.id = orders.customer_id and c.is_demo));

-- A policy cannot compare old and new, so without this anon could turn accepted into rejected, or cancel after the
-- window. Not SECURITY DEFINER, and in private, so nothing here is reachable through the Data API. Only anon is limited;
-- logged-in users keep their existing policies and the Worker's service role is untouched.
create function private.check_public_order_change() returns trigger
language plpgsql set search_path = '' as $$
begin
  if current_user = 'anon' and not (
    (old.status = 'pending' and new.status in ('accepted', 'rejected'))
    or (old.status in ('pending', 'accepted') and new.status = 'cancelled' and old.created_at > now() - interval '3 hours')
  ) then
    raise exception 'This order cannot change from % to %', old.status, new.status using errcode = '42501';
  end if;
  return new;
end
$$;
revoke execute on function private.check_public_order_change() from public, anon, authenticated;
create trigger orders_check_public_change before update on public.orders
  for each row execute function private.check_public_order_change();
