-- adapter_config can hold webhook secrets; browsers get every other column
revoke select on public.stores from anon, authenticated;
grant select (id, owner_user_id, name, phone_e164, address, lat, lng, adapter_type, is_open, delivery_fee, min_order_amount, eta_minutes) on public.stores to authenticated;
