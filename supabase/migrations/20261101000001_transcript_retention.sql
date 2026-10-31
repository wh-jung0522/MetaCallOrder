create extension if not exists pg_cron;
-- 전사문은 30일만 보관한다
select cron.schedule(
  'purge-call-transcripts',
  '0 3 * * *',
  $$update public.calls set transcript = null where transcript is not null and started_at < now() - interval '30 days'$$
);
