-- ============================================================
-- Pro Mortgage credit-check — the signed consent form is required for manual verification
-- (apply AFTER 20261001_confirm_and_cleanup.sql, then deploy mm-staff straight after)
-- Idempotent: safe to re-run. Paste into Supabase → SQL Editor → Run. One transaction.
-- ============================================================
-- Why: MortgageMAX (Bennie Vermeulen, 2026-10-01) accepts the manual route only when the client
-- has signed its Consent Form first (the Broad Consent, as a document). The consultant sends the
-- form, the client signs page 1, and the consultant uploads the signed copy with the ID copy.
-- Until both are stored, the identity questions cannot be bypassed.
--
-- ORDER: this file first, mm-staff second, the pages third. From the moment this file runs, a
-- manual verification WITHOUT a signed consent form is refused by the database itself - so the
-- mm-staff that is live before the deploy cannot save one (it reports an error; nothing is
-- written), and no caller can ever skip the form.
-- ============================================================
-- What this does:
--   1. manual_verifications gains the signed consent form: version, path, type, size, fingerprint.
--   2. record_manual_verification() takes the signed form and refuses without it. The form and
--      the ID copy must be different files.
--   3. Opening a stored signed consent form is logged like opening an ID copy.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. Evidence: the signed consent form (null only on rows from before this file)
-- ------------------------------------------------------------
alter table public.manual_verifications
  add column if not exists consent_form_version    text,
  add column if not exists consent_form_path       text,
  add column if not exists consent_form_type       text check (consent_form_type in ('application/pdf', 'image/jpeg', 'image/png')),
  add column if not exists consent_form_bytes      int  check (consent_form_bytes > 0),
  add column if not exists consent_form_sha256     text,
  add column if not exists consent_form_deleted_at timestamptz;

-- ------------------------------------------------------------
-- 2. Evidence + status change, atomically - now with the signed consent form
--    Returns the evidence id, or null when the record is no longer in p_from (nothing written).
--    The form parameters have defaults ONLY so that a call written before this file still
--    reaches this function and is refused here, instead of finding the old one.
-- ------------------------------------------------------------
drop function if exists public.record_manual_verification(text, text, uuid, text, text, text, text, text, int, text);

create or replace function public.record_manual_verification(
  p_ref text, p_from text, p_user uuid, p_label text,
  p_version text, p_text text,
  p_path text, p_type text, p_bytes int, p_sha256 text,
  p_form_version text default null, p_form_path text default null, p_form_type text default null,
  p_form_bytes int default null, p_form_sha256 text default null
) returns bigint
language plpgsql security definer set search_path = public, extensions
as $$
declare
  v_status text;
  v_id bigint;
begin
  if p_form_version is null or p_form_path is null or p_form_type is null
     or p_form_sha256 is null or coalesce(p_form_bytes, 0) <= 0 then
    raise exception 'consent_form_required';
  end if;
  if p_form_sha256 = p_sha256 or p_form_path = p_path then
    raise exception 'consent_form_same_as_id_copy';
  end if;

  select status into v_status from credit_checks where ref = p_ref for update;
  if v_status is null or v_status <> p_from then
    return null;
  end if;

  insert into manual_verifications (ref, verified_by, verified_by_label, attestation_version, attestation_text,
    attestation_sha256, document_path, document_type, document_bytes, document_sha256,
    consent_form_version, consent_form_path, consent_form_type, consent_form_bytes, consent_form_sha256)
  values (p_ref, p_user, p_label, p_version, p_text,
    encode(digest(p_text, 'sha256'), 'hex'), p_path, p_type, p_bytes, p_sha256,
    p_form_version, p_form_path, p_form_type, p_form_bytes, p_form_sha256)
  returning id into v_id;

  update credit_checks set
    status = 'manual_verified',
    manual_verified_at = now(),
    manual_verification_id = v_id,
    audit = audit || jsonb_build_object(
      'at', (extract(epoch from now()) * 1000)::bigint,
      'event', 'Identity verified manually by ' || p_label
        || ' (signed consent form + ID copy uploaded + Experian attestation)')
  where ref = p_ref;

  return v_id;
end;
$$;

revoke all on function public.record_manual_verification(text, text, uuid, text, text, text, text, text, int, text, text, text, text, int, text)
  from public, anon, authenticated;
grant execute on function public.record_manual_verification(text, text, uuid, text, text, text, text, text, int, text, text, text, text, int, text)
  to service_role;

-- ------------------------------------------------------------
-- 3. Opening a signed consent form is logged like opening an ID copy
-- ------------------------------------------------------------
alter table public.report_access_log drop constraint if exists report_access_log_action_check;
alter table public.report_access_log add constraint report_access_log_action_check
  check (action in ('view', 'download_pdf', 'view_raw', 'view_id_document', 'view_signed_consent_form'));

commit;

-- ------------------------------------------------------------
-- Verify (run separately, AFTER the block above):
--
--   select column_name from information_schema.columns
--    where table_schema = 'public' and table_name = 'manual_verifications' and column_name like 'consent_form%'
--    order by 1;                       -- six rows
--   select pronargs from pg_proc where proname = 'record_manual_verification';   -- one row: 15
--   select has_function_privilege('anon', p.oid, 'execute') from pg_proc p
--    where proname = 'record_manual_verification';                               -- false
-- ------------------------------------------------------------
