-- ============================================================
-- Pro Mortgage credit-check — retire the SMS step and the one-cellphone-one-person rule
-- (apply AFTER 20261005_submit_without_otp.sql AND after the new mm-client, mm-staff and pages
--  are live: this file REMOVES objects the older code used)
-- Idempotent: safe to re-run. Paste into Supabase → SQL Editor → Run. One transaction.
-- ============================================================
-- Why: MortgageMAX (Bennie Vermeulen, 2026-10-12): the identity questions alone verify the person,
-- so the SMS code goes. With it goes the only moment a cellphone number was proved, and Michael
-- (2026-10-12) withdrew the one-cellphone-one-person rule rather than move it. The number stays on
-- the form as the consultant's contact number.
--
-- ORDER: last. It refuses to run until 20261005 has been applied, and must follow the pages push:
-- the old store.js selects two of the columns dropped here. Run it straight after the push.
--
-- BEFORE RUNNING: `select mode, count(*) from sms_log group by 1;` - SMS never went live, so this
-- should show only mock/test rows; if a live row exists, export the table first (it holds the
-- provider's event ids and costs). `consent_events.otp_confirmed_at` keeps its name: on rows from
-- before 12 Oct it is when the SMS code was entered, on later rows when the form was accepted.
-- ============================================================
-- What this does:
--   1. Applications still waiting for an SMS code (there should be none) are expired: nothing can
--      confirm them now.
--   2. link_conflict() goes (the constraint itself went in 20261005, which the new submit needed).
--   3. The SMS step goes: confirm_consent(), submit_credit_check(), claim_otp_send(),
--      record_sms_result(), the sms_log table, and every otp_* column.
--   4. The status machine loses 'awaiting_otp'; the column's default becomes 'consent_confirmed'.
--   5. expire_stale_records() no longer looks for the SMS step.
-- ============================================================

begin;

do $$
begin
  if to_regprocedure('public.submit_application(jsonb, text, int, int)') is null then
    raise exception 'STOP: apply 20261005_submit_without_otp.sql (and deploy the new code) before this file.';
  end if;
end $$;

-- ------------------------------------------------------------
-- 1. Nothing can confirm an SMS code any more
-- ------------------------------------------------------------
update public.credit_checks set
  status = 'expired',
  audit = audit || jsonb_build_object(
    'at', (extract(epoch from now()) * 1000)::bigint,
    'event', 'Expired: the SMS step was retired before this application entered its code')
where status = 'awaiting_otp';

-- ------------------------------------------------------------
-- 2. One cellphone, one person: rule withdrawn (constraint already dropped by 20261005; kept idempotent)
-- ------------------------------------------------------------
alter table public.credit_checks drop constraint if exists one_person_per_cellphone;
drop function if exists public.link_conflict(text, text);

-- ------------------------------------------------------------
-- 3. The SMS step
-- ------------------------------------------------------------
drop function if exists public.confirm_consent(text, text);
drop function if exists public.submit_credit_check(jsonb);
drop function if exists public.claim_otp_send(text, text, boolean, text, int, int, int, int);
drop function if exists public.record_sms_result(bigint, text, int, text, text, numeric);
drop table if exists public.sms_log;

-- ------------------------------------------------------------
-- 5. The clean-up, without the SMS step (replaced BEFORE the columns it named are dropped)
-- ------------------------------------------------------------
create or replace function public.expire_stale_records()
returns int
language plpgsql security definer set search_path = public
as $$
declare n int;
begin
  -- consent_confirmed but never registered within 7 days (the client closed the page before the
  -- questions, and no consultant retried the registration).
  update credit_checks set
    status = 'expired',
    audit = audit || jsonb_build_object(
      'at', (extract(epoch from now()) * 1000)::bigint,
      'event', 'Expired automatically (abandoned before completion)')
  where status = 'consent_confirmed' and consent_confirmed_at < now() - interval '7 days';
  get diagnostics n = row_count;

  -- Abandoned identity rounds get the SAME end state the Edge Functions' recovery gives them
  -- (idv_failed, expired). Never 'expired': a consultant may still verify manually.
  update credit_checks set
    status = 'idv_failed',
    idv_result = jsonb_build_object('expired', true),
    audit = audit || jsonb_build_object(
      'at', (extract(epoch from now()) * 1000)::bigint,
      'event', 'Identity questions expired before they were answered (swept)')
  where status = 'idv_in_progress'
    and coalesce(idv_started_at, consent_registered_at, created_at) < now() - interval '24 hours';

  delete from credit_check_signals where at < now() - interval '2 days';

  delete from credit_check_secrets s using credit_checks c
   where s.ref = c.ref and c.status = 'expired';

  -- Leftover on live records: a verification request number outside an identity round.
  update credit_check_secrets s set
    verification_request_number = null,
    updated_at = now()
  from credit_checks c
  where s.ref = c.ref
    and c.status <> 'idv_in_progress' and s.verification_request_number is not null;

  return n;
end $$;

alter table public.credit_checks
  drop column if exists otp_hash,
  drop column if exists otp_expires,
  drop column if exists otp_attempts,
  drop column if exists otp_sends,
  drop column if exists otp_sent_at;
alter table public.credit_check_secrets
  drop column if exists otp_hash,
  drop column if exists otp_session_hash;

-- ------------------------------------------------------------
-- 4. Status machine (- awaiting_otp)
-- ------------------------------------------------------------
alter table public.credit_checks alter column status set default 'consent_confirmed';
alter table public.credit_checks drop constraint if exists credit_checks_status_check;
alter table public.credit_checks add constraint credit_checks_status_check
  check (status in (
    'consent_confirmed', 'consent_registered',
    'idv_in_progress', 'idv_passed', 'idv_failed', 'idv_unavailable', 'idv_waived',
    'manual_verified', 'check_in_flight', 'report_ready', 'check_failed',
    'consent_withdrawn', 'manual_required', 'expired', 'config_error',
    'report_requested'  -- legacy value from the stub; no longer written
  ));

commit;

-- ------------------------------------------------------------
-- Verify (run separately, AFTER the block above):
--
--   select proname from pg_proc where proname in ('confirm_consent', 'submit_credit_check', 'claim_otp_send',
--     'record_sms_result', 'link_conflict');                                     -- no rows
--   select to_regclass('public.sms_log');                                       -- null
--   select column_name from information_schema.columns
--    where table_schema = 'public' and table_name in ('credit_checks', 'credit_check_secrets')
--      and column_name like 'otp%';                                             -- no rows
--   select conname from pg_constraint where conname = 'one_person_per_cellphone';   -- no rows
--   select count(*) from credit_checks where status = 'awaiting_otp';          -- 0
--   select public.expire_stale_records();                                      -- a number, no error
-- ------------------------------------------------------------
