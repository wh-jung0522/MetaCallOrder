-- SECURITY DEFINER helpers must not be callable through the Data API. Policies follow the functions by OID.
create schema if not exists private;
grant usage on schema private to authenticated;
alter function public.is_guardian_of(uuid) set schema private;
alter function public.owns_store(uuid) set schema private;
