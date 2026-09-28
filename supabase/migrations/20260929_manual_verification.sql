-- ============================================================
-- Pro Mortgage credit-check — manual identity verification (apply AFTER 20260928_sms_otp.sql)
-- Idempotent: safe to re-run. Paste into Supabase → SQL Editor → Run.
-- The whole file runs in ONE transaction: if any statement fails, nothing changes.
-- ============================================================
-- Why: MortgageMAX (2026-09-28) made identity verification mandatory for every online credit
-- check. The only alternative to passing the identity questions is manual verification: a copy of
-- the client's ID uploaded to the system + the consultant confirming Experian's attestation
-- (verbatim wording in supabase/functions/_shared/manual.ts). A free-text reason is not enough.
--
-- DEPLOY ORDER: this file is ADDITIVE (new status value, columns, table, bucket, function) —
-- nothing the deployed pages or functions use is removed, so apply it FIRST, then deploy mm-staff,
-- then push the pages.
-- ============================================================
-- What this does:
--   1. Status 'manual_verified' (identity verified manually; a credit check may run from it).
--   2. credit_checks.manual_verified_at / manual_verification_id (staff-readable).
--   3. manual_verifications: the evidence — who, when, the exact attestation wording and its
--      version + sha256, the stored ID copy's path, type, size and sha256. Staff read; only the
--      service role writes. No foreign key on purpose: like consent_events it outlives a
--      destroy-on-request (delete-record removes the ID copy and stamps document_deleted_at).
--   4. Private bucket 'id-documents' (PDF / JPEG / PNG, 10 MB). Uploads arrive only through
--      one-time signed upload URLs issued by mm-staff; staff read through signed URLs.
--   5. record_manual_verification(): writes the evidence and moves the record to
--      manual_verified in one transaction, under the row lock — never evidence without the status
--      change, never the status change without evidence. Service role only.
--   6. report_access_log.action gains 'view_id_document' (opening a stored ID copy is logged).
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. Status machine (+ manual_verified)
-- ------------------------------------------------------------
alter table public.credit_checks drop constraint if exists credit_checks_status_check;
alter table public.credit_checks add constraint credit_checks_status_check
  check (status in (
    'awaiting_otp', 'consent_confirmed', 'consent_registered',
    'idv_in_progress', 'idv_passed', 'idv_failed', 'idv_unavailable', 'idv_waived',
    'manual_verified', 'check_in_flight', 'report_ready', 'check_failed',
    'consent_withdrawn', 'manual_required', 'expired', 'config_error',
    'report_requested'  -- legacy value from the stub; no longer written
  ));

-- ------------------------------------------------------------
-- 2. Columns
-- ------------------------------------------------------------
alter table public.credit_checks
  add column if not exists manual_verified_at     timestamptz,
  add column if not exists manual_verification_id bigint;

-- ------------------------------------------------------------
-- 3. Evidence
-- ------------------------------------------------------------
create table if not exists public.manual_verifications (
  id                  bigint generated always as identity primary key,
  created_at          timestamptz not null default now(),
  ref                 text not null,
  verified_by         uuid not null,
  verified_by_label   text not null,
  attestation_version text not null,
  attestation_text    text not null,
  attestation_sha256  text not null,
  document_path       text not null,
  document_type       text not null check (document_type in ('application/pdf', 'image/jpeg', 'image/png')),
  document_bytes      int  not null check (document_bytes > 0),
  document_sha256     text not null,
  document_deleted_at timestamptz
);
create index if not exists manual_verifications_ref_idx on public.manual_verifications (ref, created_at desc);

alter table public.manual_verifications enable row level security;
revoke all on table public.manual_verifications from anon;
drop policy if exists staff_read on public.manual_verifications;
create policy staff_read on public.manual_verifications for select to authenticated using (true);
revoke insert, update, delete on table public.manual_verifications from authenticated;

-- ------------------------------------------------------------
-- 4. Private bucket for ID copies
-- ------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('id-documents', 'id-documents', false, 10485760, array['application/pdf', 'image/jpeg', 'image/png'])
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "id-documents staff read" on storage.objects;
create policy "id-documents staff read" on storage.objects
  for select to authenticated using (bucket_id = 'id-documents');

-- ------------------------------------------------------------
-- 5. Evidence + status change, atomically
--    Returns the evidence id, or null when the record is no longer in p_from (nothing written).
-- ------------------------------------------------------------
create or replace function public.record_manual_verification(
  p_ref text, p_from text, p_user uuid, p_label text,
  p_version text, p_text text,
  p_path text, p_type text, p_bytes int, p_sha256 text
) returns bigint
language plpgsql security definer set search_path = public, extensions
as $$
declare
  v_status text;
  v_id bigint;
begin
  select status into v_status from credit_checks where ref = p_ref for update;
  if v_status is null or v_status <> p_from then
    return null;
  end if;

  insert into manual_verifications (ref, verified_by, verified_by_label, attestation_version, attestation_text,
    attestation_sha256, document_path, document_type, document_bytes, document_sha256)
  values (p_ref, p_user, p_label, p_version, p_text,
    encode(digest(p_text, 'sha256'), 'hex'), p_path, p_type, p_bytes, p_sha256)
  returning id into v_id;

  update credit_checks set
    status = 'manual_verified',
    manual_verified_at = now(),
    manual_verification_id = v_id,
    audit = audit || jsonb_build_object(
      'at', (extract(epoch from now()) * 1000)::bigint,
      'event', 'Identity verified manually by ' || p_label || ' (ID copy uploaded + Experian attestation)')
  where ref = p_ref;

  return v_id;
end;
$$;

revoke all on function public.record_manual_verification(text, text, uuid, text, text, text, text, text, int, text)
  from public, anon, authenticated;
grant execute on function public.record_manual_verification(text, text, uuid, text, text, text, text, text, int, text)
  to service_role;

-- ------------------------------------------------------------
-- 6. Opening an ID copy is logged like opening a report
-- ------------------------------------------------------------
alter table public.report_access_log drop constraint if exists report_access_log_action_check;
alter table public.report_access_log add constraint report_access_log_action_check
  check (action in ('view', 'download_pdf', 'view_raw', 'view_id_document'));

commit;
