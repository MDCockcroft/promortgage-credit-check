-- ============================================================
-- Pro Mortgage credit-check — retention: expired applications deleted after 30 days, credit reports
-- deleted after 12 months, a weekly copy of the stored files (Operator Agreement, 28 Oct 2026)
-- (apply AFTER 20261009_client_id_upload.sql; then deploy mm-maintenance and mm-staff, push the pages,
-- set MAINTENANCE_TOKEN, and schedule the two cron jobs — supabase/cron/retention.sql)
-- Idempotent: safe to re-run. Paste into Supabase → SQL Editor → Run. One transaction.
-- ============================================================
-- Why: the Operator Agreement with Pro Mortgage commits ARRABON to three things the system did not yet
-- do: (1) applications that expired are deleted 30 days later; (2) a credit report is deleted 12 months
-- after it was received, keeping only the date, the risk band and the enquiry reference; (3) the stored
-- files (ID copies, signed forms, report PDFs) are copied weekly and the copies kept 30 days, because
-- the host's daily backups cover the database only. The deletions and the copy run from a new Edge
-- Function (mm-maintenance) on a schedule; this file gives it what it needs in the database.
-- ============================================================
-- What this does:
--   1. credit_checks.expired_at (when the clean-up expired the application) and report_purged_at.
--   2. expire_stale_records() stamps expired_at; existing expired rows are backfilled.
--   3. purge_report(ref): removes the report data and PDF reference of a report older than 12 months,
--      keeps the risk band and enquiry reference, audits; returns the PDF path to delete. Server-only.
--   4. A private bucket 'file-backups' for the weekly copies (service role only — no read policy).
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. Timestamps
-- ------------------------------------------------------------
alter table public.credit_checks
  add column if not exists expired_at       timestamptz,
  add column if not exists report_purged_at timestamptz;

create index if not exists credit_checks_expired_at_idx on public.credit_checks (expired_at) where status = 'expired';
create index if not exists credit_checks_report_ready_idx on public.credit_checks (report_ready_at) where status = 'report_ready';

-- Applications expired before this file: the clean-up expires an abandoned application 7 days after
-- the consent was confirmed, so that is when it happened (never later than now).
update public.credit_checks
   set expired_at = least(now(), coalesce(consent_confirmed_at, created_at) + interval '7 days')
 where status = 'expired' and expired_at is null;

-- ------------------------------------------------------------
-- 2. The clean-up stamps expired_at (otherwise as in 20261006)
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
    expired_at = now(),
    audit = audit || jsonb_build_object(
      'at', (extract(epoch from now()) * 1000)::bigint,
      'event', 'Expired automatically (abandoned before completion)')
  where status = 'consent_confirmed' and consent_confirmed_at < now() - interval '7 days';
  get diagnostics n = row_count;

  -- An expired application without its stamp (expired by another route, or before 20261010) is
  -- stamped at its 7-day mark, so the 30-day deletion never waits on a guess.
  update credit_checks
     set expired_at = least(now(), coalesce(consent_confirmed_at, created_at) + interval '7 days')
   where status = 'expired' and expired_at is null;

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

revoke all on function public.expire_stale_records() from public, anon, authenticated;

-- ------------------------------------------------------------
-- 3. Deleting a credit report after 12 months: the data and the PDF reference go; the date received,
--    the risk band and the enquiry reference stay. Returns the PDF's storage path (to delete), or null
--    when the record is not due (not report_ready, already purged, or younger than 12 months).
-- ------------------------------------------------------------
create or replace function public.purge_report(p_ref text)
returns text
language plpgsql security definer set search_path = public
as $$
declare
  v_pdf     text;
  v_summary jsonb;
begin
  select report_pdf_path, coalesce(report_summary, '{}'::jsonb) into v_pdf, v_summary
    from credit_checks
   where ref = p_ref and status = 'report_ready' and report_purged_at is null
     and report_ready_at < now() - interval '12 months'
   for update;
  if not found then return null; end if;

  update credit_checks set
    report_json = null,
    affordability_json = null,
    report_pdf_path = null,
    pdf_status = null,
    report_summary = jsonb_build_object(
      'riskType', v_summary -> 'riskType',
      'rag', v_summary -> 'rag',
      'enquiryId', v_summary -> 'enquiryId',
      'purged', true),
    report_purged_at = now(),
    audit = audit || jsonb_build_object(
      'at', (extract(epoch from now()) * 1000)::bigint,
      'event', 'Credit report deleted 12 months after receipt (retention); the risk band and enquiry reference are kept')
  where ref = p_ref;
  return v_pdf;
end $$;

revoke all on function public.purge_report(text) from public, anon, authenticated;
grant execute on function public.purge_report(text) to service_role;

-- ------------------------------------------------------------
-- 4. The weekly copies of the stored files: private, service role only (no policy at all).
-- ------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit)
values ('file-backups', 'file-backups', false, 20971520)
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;

commit;

-- ------------------------------------------------------------
-- Verify (run separately, AFTER the block above):
--
--   select column_name from information_schema.columns
--    where table_schema = 'public' and table_name = 'credit_checks' and column_name in ('expired_at', 'report_purged_at'); -- two rows
--   select count(*) from credit_checks where status = 'expired' and expired_at is null;                                   -- 0
--   select has_function_privilege('anon', 'public.purge_report(text)', 'execute');                                        -- false
--   select id, public from storage.buckets where id = 'file-backups';                                                     -- one row, false
--   select count(*) from pg_policies where tablename = 'objects' and policyname ilike '%file-backups%';                    -- 0
-- ------------------------------------------------------------
