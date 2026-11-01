-- What happened inside a call, in order, for admins debugging it. ms is on the same clock as the call's audio file.
create table public.call_logs (
  call_sid text not null references public.calls(call_sid) on delete cascade,
  seq integer not null,
  at timestamptz not null,
  ms integer not null,
  kind text not null,
  payload jsonb not null default '{}',
  primary key (call_sid, seq)
);
alter table public.call_logs enable row level security;

-- Only the Worker's service role writes. Browsers read, and only as an admin.
revoke all on public.call_logs from anon, authenticated;
grant select on public.call_logs to authenticated;
create policy call_logs_admin_select on public.call_logs for select to authenticated
  using ((select public.is_admin()));

-- Private bucket: no public URL, and without a policy anon can neither list nor sign. 32 MiB holds the longest
-- call the Worker can record (see apps/voice-worker/src/recording.ts).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('call-audio', 'call-audio', false, 33554432, array['audio/wav'])
on conflict (id) do nothing;
create policy call_audio_admin_read on storage.objects for select to authenticated
  using (bucket_id = 'call-audio' and (select public.is_admin()));

-- Same 30 days as the transcripts. The audio files cannot be purged from here: storage.objects has a trigger
-- (protect_objects_delete) that refuses direct deletes, and a row delete would orphan the file anyway. The Worker's
-- daily cron removes them through the Storage API instead.
select cron.schedule(
  'purge-call-logs',
  '0 3 * * *',
  $$delete from public.call_logs where at < now() - interval '30 days'$$
);
