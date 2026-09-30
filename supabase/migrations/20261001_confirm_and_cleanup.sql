-- ============================================================
-- Pro Mortgage credit-check — scheduled clean-up, and the SMS-code check behind the server
-- (apply AFTER 20260930_consultant_roles.sql, and only once BOTH are live:
--    1. mm-client with the 'confirm' action is deployed, and
--    2. the pages that use it are published (store.js?v=20260930-1 or later).
--  Applied earlier, any page still calling confirm_consent directly stops confirming codes.)
-- Idempotent: safe to re-run. Paste into Supabase → SQL Editor → Run. One transaction.
-- ============================================================
-- Why:
--   1. expire_stale_records() (20260927) expires abandoned applications and clears their
--      leftover secrets, but nothing ever ran it: abandoned forms stayed "Waiting on client"
--      for ever. It now runs every hour through pg_cron.
--   2. confirm_consent was callable by anyone who knew a reference: it said whether the
--      reference existed and let a stranger use up the client's five code attempts. The form
--      now confirms through mm-client, which first checks the session token that only the
--      submitting browser holds (the same proof "Send a new code" already needs). With this
--      file the public can call no database function directly.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. Scheduled clean-up (pg_cron; times are UTC)
-- ------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    -- Only a local test database lacks pg_cron; every Supabase project has it.
    raise notice 'pg_cron is not available on this server: the clean-up was NOT scheduled.';
    return;
  end if;
  create extension if not exists pg_cron with schema pg_catalog;
  grant usage on schema cron to postgres;
  grant all privileges on all tables in schema cron to postgres;
  -- Scheduling under an existing name replaces that job, so re-running never duplicates it.
  perform cron.schedule('pm-expire-stale-records', '17 * * * *', 'select public.expire_stale_records()');
  -- pg_cron keeps a row per run and never prunes them: keep 30 days, pruned every Sunday.
  perform cron.schedule('pm-prune-cron-history', '47 2 * * 0',
    $c$delete from cron.job_run_details where end_time < now() - interval '30 days'$c$);
end $$;

-- ------------------------------------------------------------
-- 2. The SMS-code check is server-only
-- ------------------------------------------------------------
revoke all on function public.confirm_consent(text, text) from public, anon, authenticated;
grant execute on function public.confirm_consent(text, text) to service_role;

commit;

-- ------------------------------------------------------------
-- Verify (run separately, AFTER the block above):
--
--   select jobname, schedule, active from cron.job where jobname like 'pm-%' order by 1;
--     -- two rows, both active
--   select has_function_privilege('anon', 'public.confirm_consent(text,text)', 'execute');
--     -- false
--   -- Within the hour, the first run:
--   select status, return_message, start_time from cron.job_run_details
--    where jobid = (select jobid from cron.job where jobname = 'pm-expire-stale-records')
--    order by start_time desc limit 5;
--     -- status 'succeeded'
-- ------------------------------------------------------------
