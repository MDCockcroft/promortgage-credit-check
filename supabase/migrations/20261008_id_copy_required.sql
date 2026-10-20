-- ============================================================
-- Pro Mortgage credit-check — the client's ID copy on every record; the manual route without the photo
-- (apply AFTER 20261007_mortgagemax_person.sql; then deploy mm-staff and push the pages straight after)
-- Idempotent: safe to re-run. Paste into Supabase → SQL Editor → Run. One transaction.
-- ============================================================
-- Why (Michael, 2026-10-20): a copy of the client's ID document must be attached to EVERY record, and
-- no credit check may run without it — Experian may ask for it in an audit. The consultant attaches
-- it (replace allowed; not mid-check). The manual override no longer takes a photo of the client: it
-- is the signed MortgageMAX consent form plus the consultant's confirmations (the Experian statement
-- and the identity confirmation, both verbatim), with the ID copy already on the record.
--
-- ORDER: this file first, mm-staff second, the pages third. From the moment this file runs, a credit
-- check on a record without an ID copy is refused by the database itself (the gate below), and the
-- previous manual-verification function is gone - the mm-staff live before the deploy cannot save a
-- manual verification until it is deployed (it reports an error; nothing is written).
-- ============================================================
-- What this does:
--   1. credit_checks.id_document_*: the ID copy on the record (path, type, size, fingerprint, who, when).
--   2. A gate: no record may enter check_in_flight without an ID copy (raises id_copy_required).
--   3. attach_id_copy(): sets the ID copy atomically, refuses mid-check, audits, returns the replaced path.
--   4. manual_verifications: the photo / ID-copy columns become optional (older rows keep theirs); the
--      identity confirmation is added. record_manual_verification() takes the signed form and the two
--      statements, and refuses without the form, the confirmation, or an ID copy on the record.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. The ID copy on the record
-- ------------------------------------------------------------
alter table public.credit_checks
  add column if not exists id_document_path        text,
  add column if not exists id_document_type        text check (id_document_type in ('application/pdf', 'image/jpeg', 'image/png')),
  add column if not exists id_document_bytes       int  check (id_document_bytes > 0),
  add column if not exists id_document_sha256      text,
  add column if not exists id_document_uploaded_by uuid,
  add column if not exists id_document_uploaded_at timestamptz;

-- ------------------------------------------------------------
-- 2. The gate: a credit check cannot be claimed without the ID copy
-- ------------------------------------------------------------
create or replace function public.credit_checks_require_id_copy()
returns trigger
language plpgsql
as $$
begin
  if new.status = 'check_in_flight' and old.status is distinct from 'check_in_flight' and new.id_document_path is null then
    raise exception 'id_copy_required' using errcode = '23514';
  end if;
  return new;
end $$;

-- A trigger function runs as the table's owner; nobody calls it directly.
revoke all on function public.credit_checks_require_id_copy() from public, anon, authenticated;

drop trigger if exists credit_checks_require_id_copy on public.credit_checks;
create trigger credit_checks_require_id_copy
  before update of status on public.credit_checks
  for each row execute function public.credit_checks_require_id_copy();

-- ------------------------------------------------------------
-- 3. Attaching (or replacing) the ID copy. Returns the previous path (to delete), or null.
-- ------------------------------------------------------------
create or replace function public.attach_id_copy(
  p_ref text, p_user uuid, p_label text, p_path text, p_type text, p_bytes int, p_sha256 text
) returns text
language plpgsql security definer set search_path = public, extensions
as $$
declare
  v_status   text;
  v_previous text;
begin
  if p_path is null or p_type is null or p_sha256 is null or coalesce(p_bytes, 0) <= 0 then
    raise exception 'id_copy_invalid';
  end if;
  select status, id_document_path into v_status, v_previous from credit_checks where ref = p_ref for update;
  if v_status is null then raise exception 'no_such_record'; end if;
  if v_status = 'check_in_flight' then raise exception 'id_copy_busy'; end if;

  update credit_checks set
    id_document_path = p_path, id_document_type = p_type, id_document_bytes = p_bytes, id_document_sha256 = p_sha256,
    id_document_uploaded_by = p_user, id_document_uploaded_at = now(),
    audit = audit || jsonb_build_object(
      'at', (extract(epoch from now()) * 1000)::bigint,
      'event', case when v_previous is null then 'Client''s ID copy attached by ' || p_label
                    else 'Client''s ID copy replaced by ' || p_label end)
  where ref = p_ref;
  return v_previous;
end $$;

revoke all on function public.attach_id_copy(text, uuid, text, text, text, int, text) from public, anon, authenticated;
grant execute on function public.attach_id_copy(text, uuid, text, text, text, int, text) to service_role;

-- ------------------------------------------------------------
-- 4. Manual verification: signed form + the two statements; the ID copy lives on the record
-- ------------------------------------------------------------
alter table public.manual_verifications
  alter column document_kind drop not null,
  alter column document_path drop not null,
  alter column document_type drop not null,
  alter column document_bytes drop not null,
  alter column document_sha256 drop not null,
  add column if not exists confirmation_version text,
  add column if not exists confirmation_text    text,
  add column if not exists confirmation_sha256  text;

drop function if exists public.record_manual_verification(text, text, uuid, text, text, text, text, text, int, text, text, text, text, int, text, text);

create or replace function public.record_manual_verification(
  p_ref text, p_from text, p_user uuid, p_label text,
  p_version text, p_text text,
  p_form_version text, p_form_path text, p_form_type text, p_form_bytes int, p_form_sha256 text,
  p_confirm_version text, p_confirm_text text
) returns bigint
language plpgsql security definer set search_path = public, extensions
as $$
declare
  v_status  text;
  v_id_path text;
  v_id      bigint;
begin
  if p_form_version is null or p_form_path is null or p_form_type is null
     or p_form_sha256 is null or coalesce(p_form_bytes, 0) <= 0 then
    raise exception 'consent_form_required';
  end if;
  if p_confirm_version is null or p_confirm_text is null or p_text is null or p_version is null then
    raise exception 'confirmation_required';
  end if;

  select status, id_document_path into v_status, v_id_path from credit_checks where ref = p_ref for update;
  if v_status is null or v_status <> p_from then
    return null;
  end if;
  if v_id_path is null then
    raise exception 'id_copy_required';
  end if;

  insert into manual_verifications (ref, verified_by, verified_by_label, attestation_version, attestation_text,
    attestation_sha256, consent_form_version, consent_form_path, consent_form_type, consent_form_bytes, consent_form_sha256,
    confirmation_version, confirmation_text, confirmation_sha256)
  values (p_ref, p_user, p_label, p_version, p_text,
    encode(digest(p_text, 'sha256'), 'hex'), p_form_version, p_form_path, p_form_type, p_form_bytes, p_form_sha256,
    p_confirm_version, p_confirm_text, encode(digest(p_confirm_text, 'sha256'), 'hex'))
  returning id into v_id;

  update credit_checks set
    status = 'manual_verified',
    manual_verified_at = now(),
    manual_verification_id = v_id,
    audit = audit || jsonb_build_object(
      'at', (extract(epoch from now()) * 1000)::bigint,
      'event', 'Identity verified manually by ' || p_label
        || ' (signed consent form + Experian statement + identity confirmation; ID copy on record)')
  where ref = p_ref;

  return v_id;
end $$;

revoke all on function public.record_manual_verification(text, text, uuid, text, text, text, text, text, text, int, text, text, text)
  from public, anon, authenticated;
grant execute on function public.record_manual_verification(text, text, uuid, text, text, text, text, text, text, int, text, text, text)
  to service_role;

commit;

-- ------------------------------------------------------------
-- Verify (run separately, AFTER the block above):
--
--   select column_name from information_schema.columns
--    where table_schema = 'public' and table_name = 'credit_checks' and column_name like 'id_document%' order by 1;  -- six rows
--   select tgname from pg_trigger where tgname = 'credit_checks_require_id_copy';                                  -- one row
--   select pronargs from pg_proc where proname = 'record_manual_verification';                                      -- one row: 13
--   select has_function_privilege('anon', 'public.attach_id_copy(text, uuid, text, text, text, int, text)', 'execute'); -- false
-- ------------------------------------------------------------
