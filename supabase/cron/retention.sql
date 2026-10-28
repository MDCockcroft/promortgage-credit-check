-- ============================================================
-- Scheduling the retention jobs (Operator Agreement, 28 Oct 2026) — run in Supabase → SQL Editor.
-- Prerequisites, in this order:
--   1. Migration 20261010_retention.sql applied; mm-maintenance deployed (--no-verify-jwt).
--   2. A secret shared by the function and the database. Make one:   openssl rand -hex 32
--      Set it on the function:  supabase secrets set MAINTENANCE_TOKEN=<value> --project-ref mxakigcvckhmyppoiuds
--      and store the SAME value in the database vault (replace <value> below).
--   3. Extensions pg_cron and pg_net enabled (Dashboard → Database → Extensions). pg_cron already runs
--      the hourly clean-up; pg_net is new and lets the database call the function.
-- The token is the only secret here; it never goes in the repo (this file holds a placeholder).
-- ============================================================

-- 2. the shared secret, once (re-running with a new value: select vault.update_secret(id, '<value>') by id)
select vault.create_secret('<value>', 'maintenance_token', 'mm-maintenance x-maintenance-token');

-- 3. the jobs (re-running replaces the job of the same name)
select cron.schedule(
  'retention-sweep-daily',           -- 02:30 UTC every day: expired applications + 12-month reports
  '30 2 * * *',
  $$
  select net.http_post(
    url     := 'https://mxakigcvckhmyppoiuds.supabase.co/functions/v1/mm-maintenance',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-maintenance-token', (select decrypted_secret from vault.decrypted_secrets where name = 'maintenance_token')),
    body    := '{"action":"sweep"}'::jsonb,
    timeout_milliseconds := 140000)
  $$);

select cron.schedule(
  'file-backup-weekly',              -- 03:00 UTC every Sunday: copy the stored files, prune copies older than 30 days
  '0 3 * * 0',
  $$
  select net.http_post(
    url     := 'https://mxakigcvckhmyppoiuds.supabase.co/functions/v1/mm-maintenance',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-maintenance-token', (select decrypted_secret from vault.decrypted_secrets where name = 'maintenance_token')),
    body    := '{"action":"backup-files"}'::jsonb,
    timeout_milliseconds := 140000)
  $$);

-- ------------------------------------------------------------
-- Verify:
--   select jobname, schedule, active from cron.job order by jobname;          -- both jobs, active
--   -- run one now rather than waiting for the schedule:
--   select cron.schedule('retention-sweep-now', '* * * * *', (select command from cron.job where jobname = 'retention-sweep-daily'));
--   -- ...wait a minute, then:
--   select cron.unschedule('retention-sweep-now');
--   select jobname, status, return_message, start_time from cron.job_run_details order by start_time desc limit 5;
--   -- the function's own line (Dashboard → Edge Functions → mm-maintenance → Logs): {"event":"retention_sweep",...}
--   -- the weekly copy, after its first run (storage, bucket file-backups): one dated folder.
-- ------------------------------------------------------------
