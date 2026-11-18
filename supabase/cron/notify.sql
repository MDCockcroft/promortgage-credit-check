-- ============================================================
-- Scheduling the notification emails — run in Supabase → SQL Editor.
-- Prerequisites, in this order:
--   1. Migration 20261011_notifications.sql applied; mm-maintenance deployed (--no-verify-jwt).
--   2. The mail service key and the sender set on the function:
--        supabase secrets set RESEND_API_KEY=<key> --project-ref mxakigcvckhmyppoiuds
--        supabase secrets set NOTIFY_FROM='Pro Mortgage Credit Check <notifications@promortgagesa.co.za>' --project-ref mxakigcvckhmyppoiuds
--      (the domain must show as verified in Resend first, or every send is refused)
--   3. The maintenance token is already in the vault (supabase/cron/retention.sql).
-- No secret in this file.
-- ============================================================

select cron.schedule(
  'notify-every-minute',             -- emails owners about applications that became ready or need attention
  '* * * * *',
  $$
  select net.http_post(
    url     := 'https://mxakigcvckhmyppoiuds.supabase.co/functions/v1/mm-maintenance',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-maintenance-token', (select decrypted_secret from vault.decrypted_secrets where name = 'maintenance_token')),
    body    := '{"action":"notify"}'::jsonb,
    timeout_milliseconds := 140000)
  $$);

-- ------------------------------------------------------------
-- Verify:
--   select jobname, schedule, active from cron.job order by jobname;
--   -- the function's own line (Dashboard → Edge Functions → mm-maintenance → Logs): {"event":"notify",...}
--   -- what has been sent, and what is waiting out its 10 minutes:
--   select ref, kind, first_seen_at, sent_at, note from notification_log
--    where note is null order by first_seen_at desc limit 20;
-- Switch off (keeps everything else): select cron.unschedule('notify-every-minute');
-- ------------------------------------------------------------
