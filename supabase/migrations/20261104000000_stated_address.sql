-- What a first-time caller says their address is. Orders still go to default_address, the demo address, while this is a demo.
-- No grant to anon: only the service role and the admin see it.
alter table public.customers add column stated_address text;
