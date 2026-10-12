-- ============================================================
-- Pro Mortgage credit-check — the consultant's photo of the client replaces the ID copy in manual
-- verification (apply AFTER 20261003_one_phone_one_person.sql, then deploy mm-staff straight after)
-- Idempotent: safe to re-run. Paste into Supabase → SQL Editor → Run. One transaction.
-- ============================================================
-- Why: MortgageMAX (Bennie Vermeulen, 2026-10-12): when a client fails the identity questions, the
-- consultant may override only with proof that they verified the person themselves - a photo of the
-- client taken by the consultant, in person, with the client holding their ID document - kept with the
-- signed consent form (2026-10-01) and the Experian attestation. An uploaded ID copy is no longer the
-- evidence.
--
-- ORDER: this file first, mm-staff second, the pages third. From the moment this file runs, a manual
-- verification WITHOUT a photo of the client (an ID copy, or any PDF) is refused by the database
-- itself - so the mm-staff that is live before the deploy cannot save one (it reports an error;
-- nothing is written), and no caller can ever pass an ID copy or a PDF off as the photo.
-- ============================================================
-- What this does:
--   1. manual_verifications.document_kind: 'id_copy' on the rows from before this file, 'client_photo'
--      from now on. No default afterwards - every new row must say what its file is.
--   2. record_manual_verification() takes the kind and refuses unless it is a client photo of an image
--      type. The signed form is still required, and the two files must still differ.
--   3. Opening a stored photo is logged like opening an ID copy or a signed form; so is downloading
--      the client's completed application form (the PDF the register builds from the record).
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. Evidence: what the stored document is
-- ------------------------------------------------------------
alter table public.manual_verifications
  add column if not exists document_kind text not null default 'id_copy'
    check (document_kind in ('id_copy', 'client_photo'));
alter table public.manual_verifications alter column document_kind drop default;

-- ------------------------------------------------------------
-- 2. Evidence + status change, atomically - now with the photo of the client
--    Returns the evidence id, or null when the record is no longer in p_from (nothing written).
--    p_kind has a default ONLY so that a call written before this file still reaches this function
--    and is refused here, instead of finding the old one.
-- ------------------------------------------------------------
drop function if exists public.record_manual_verification(text, text, uuid, text, text, text, text, text, int, text, text, text, text, int, text);

create or replace function public.record_manual_verification(
  p_ref text, p_from text, p_user uuid, p_label text,
  p_version text, p_text text,
  p_path text, p_type text, p_bytes int, p_sha256 text,
  p_form_version text default null, p_form_path text default null, p_form_type text default null,
  p_form_bytes int default null, p_form_sha256 text default null,
  p_kind text default null
) returns bigint
language plpgsql security definer set search_path = public, extensions
as $$
declare
  v_status text;
  v_id bigint;
begin
  if p_kind is distinct from 'client_photo' then
    raise exception 'client_photo_required';
  end if;
  if p_type is null or p_type not in ('image/jpeg', 'image/png') then
    raise exception 'client_photo_must_be_image';
  end if;
  if p_form_version is null or p_form_path is null or p_form_type is null
     or p_form_sha256 is null or coalesce(p_form_bytes, 0) <= 0 then
    raise exception 'consent_form_required';
  end if;
  if p_form_sha256 = p_sha256 or p_form_path = p_path then
    raise exception 'consent_form_same_as_photo';
  end if;

  select status into v_status from credit_checks where ref = p_ref for update;
  if v_status is null or v_status <> p_from then
    return null;
  end if;

  insert into manual_verifications (ref, verified_by, verified_by_label, attestation_version, attestation_text,
    attestation_sha256, document_kind, document_path, document_type, document_bytes, document_sha256,
    consent_form_version, consent_form_path, consent_form_type, consent_form_bytes, consent_form_sha256)
  values (p_ref, p_user, p_label, p_version, p_text,
    encode(digest(p_text, 'sha256'), 'hex'), p_kind, p_path, p_type, p_bytes, p_sha256,
    p_form_version, p_form_path, p_form_type, p_form_bytes, p_form_sha256)
  returning id into v_id;

  update credit_checks set
    status = 'manual_verified',
    manual_verified_at = now(),
    manual_verification_id = v_id,
    audit = audit || jsonb_build_object(
      'at', (extract(epoch from now()) * 1000)::bigint,
      'event', 'Identity verified manually by ' || p_label
        || ' (signed consent form + photo of the client + Experian attestation)')
  where ref = p_ref;

  return v_id;
end;
$$;

revoke all on function public.record_manual_verification(text, text, uuid, text, text, text, text, text, int, text, text, text, text, int, text, text)
  from public, anon, authenticated;
grant execute on function public.record_manual_verification(text, text, uuid, text, text, text, text, text, int, text, text, text, text, int, text, text)
  to service_role;

-- ------------------------------------------------------------
-- 3. Opening a stored photo of the client is logged
-- ------------------------------------------------------------
alter table public.report_access_log drop constraint if exists report_access_log_action_check;
alter table public.report_access_log add constraint report_access_log_action_check
  check (action in ('view', 'download_pdf', 'view_raw', 'view_id_document', 'view_signed_consent_form', 'view_client_photo', 'download_form'));

commit;

-- ------------------------------------------------------------
-- Verify (run separately, AFTER the block above):
--
--   select column_default, is_nullable from information_schema.columns
--    where table_schema = 'public' and table_name = 'manual_verifications' and column_name = 'document_kind';
--                                      -- one row: null, NO
--   select pronargs from pg_proc where proname = 'record_manual_verification';   -- one row: 16
--   select has_function_privilege('anon', p.oid, 'execute') from pg_proc p
--    where proname = 'record_manual_verification';                               -- false
-- ------------------------------------------------------------
