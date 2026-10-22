-- ============================================================
-- Pro Mortgage credit-check — the client may add a copy of their ID on the form (front and back)
-- (apply AFTER 20261008_id_copy_required.sql; then deploy mm-client AND mm-staff, and push the pages)
-- Idempotent: safe to re-run. Paste into Supabase → SQL Editor → Run. One transaction.
-- ============================================================
-- Why (Michael, 2026-10-20, late): the ID copy every record needs (20261008) may come from the client
-- themselves, as an option on the online form — a photo of the front, and of the back for a smart ID
-- card or a driver's licence (two separate pictures), taken on the phone or chosen as a file. It counts
-- as the ID copy on the record; the consultant can still replace it (which drops the back as well).
-- The client gets ONE attach per application: once any copy is on the record (theirs or a consultant's)
-- the client can no longer change it — so what a consultant opened and checked cannot be swapped under
-- them, and a replayed call cannot bloat the record.
--
-- ORDER: this file first, then BOTH functions straight after, then the pages. The columns are additive;
-- the page works either side of this file (it reads the back-of-card columns only when they exist).
-- The staff attach function keeps its arguments but now returns text[] instead of text: the mm-staff
-- deployed before this file still attaches correctly, but until it is redeployed it deletes no replaced
-- file from storage (orphans, swept by delete-record) and reports "replaced" on a first attach. Keep
-- the gap short.
-- ============================================================
-- What this does:
--   1. credit_checks.id_document_source ('client' | 'staff') and id_document_back_* (the back of the card).
--   2. attach_id_copy() (staff): also clears the back; returns EVERY replaced path (text[]), to delete;
--      the path must be this record's own idcopy- object.
--   3. attach_id_copy_client(): the client's own upload — the front (required) and the back — only while
--      the application is still the client's turn and only while the record has no copy yet. Server-only.
--   4. report_access_log.action gains 'view_id_document_back' (opening the back of the card is logged
--      as such).
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. Who attached the copy, and the back of the card
-- ------------------------------------------------------------
alter table public.credit_checks
  add column if not exists id_document_source      text check (id_document_source in ('client', 'staff')),
  add column if not exists id_document_back_path   text,
  add column if not exists id_document_back_type   text check (id_document_back_type in ('application/pdf', 'image/jpeg', 'image/png')),
  add column if not exists id_document_back_bytes  int  check (id_document_back_bytes > 0),
  add column if not exists id_document_back_sha256 text;

-- Copies attached before this file were all attached by staff.
update public.credit_checks set id_document_source = 'staff'
 where id_document_path is not null and id_document_source is null;

-- ------------------------------------------------------------
-- 2. The consultant attaches (or replaces) the ID copy: one file, the back goes with the old front.
--    Returns the replaced paths (to delete from storage) — empty when nothing was there.
-- ------------------------------------------------------------
drop function if exists public.attach_id_copy(text, uuid, text, text, text, int, text);

create or replace function public.attach_id_copy(
  p_ref text, p_user uuid, p_label text, p_path text, p_type text, p_bytes int, p_sha256 text
) returns text[]
language plpgsql security definer set search_path = public, extensions
as $$
declare
  v_status     text;
  v_prev_front text;
  v_prev_back  text;
begin
  if p_path is null or p_type is null or p_sha256 is null or coalesce(p_bytes, 0) <= 0
     or p_path not like p_ref || '/idcopy-%' then
    raise exception 'id_copy_invalid';
  end if;
  select status, id_document_path, id_document_back_path into v_status, v_prev_front, v_prev_back
    from credit_checks where ref = p_ref for update;
  if v_status is null then raise exception 'no_such_record'; end if;
  if v_status = 'check_in_flight' then raise exception 'id_copy_busy'; end if;

  update credit_checks set
    id_document_path = p_path, id_document_type = p_type, id_document_bytes = p_bytes, id_document_sha256 = p_sha256,
    id_document_uploaded_by = p_user, id_document_uploaded_at = now(), id_document_source = 'staff',
    id_document_back_path = null, id_document_back_type = null, id_document_back_bytes = null, id_document_back_sha256 = null,
    audit = audit || jsonb_build_object(
      'at', (extract(epoch from now()) * 1000)::bigint,
      'event', case when v_prev_front is null then 'Client''s ID copy attached by ' || p_label
                    else 'Client''s ID copy replaced by ' || p_label end)
  where ref = p_ref;
  return array_remove(array[v_prev_front, v_prev_back], null);
end $$;

revoke all on function public.attach_id_copy(text, uuid, text, text, text, int, text) from public, anon, authenticated;
grant execute on function public.attach_id_copy(text, uuid, text, text, text, int, text) to service_role;

-- ------------------------------------------------------------
-- 3. The client's own upload from the form: the front (required) and the back (optional).
--    Only while the application is still with the client (before any check), and only while the record
--    has no copy yet — one attach per application; afterwards only a consultant can change the copy.
-- ------------------------------------------------------------
drop function if exists public.attach_id_copy_client(text, text, text, int, text, text, text, int, text);

create or replace function public.attach_id_copy_client(
  p_ref text,
  p_front_path text, p_front_type text, p_front_bytes int, p_front_sha256 text,
  p_back_path text, p_back_type text, p_back_bytes int, p_back_sha256 text
) returns void
language plpgsql security definer set search_path = public, extensions
as $$
declare
  v_status     text;
  v_prev_front text;
begin
  if p_front_path is null or p_front_type is null or p_front_sha256 is null or coalesce(p_front_bytes, 0) <= 0
     or p_front_path not like p_ref || '/idcopy-%' then
    raise exception 'id_copy_invalid';
  end if;
  if p_back_path is not null and (p_back_type is null or p_back_sha256 is null or coalesce(p_back_bytes, 0) <= 0
     or p_back_path not like p_ref || '/idback-%') then
    raise exception 'id_copy_invalid';
  end if;
  select status, id_document_path into v_status, v_prev_front
    from credit_checks where ref = p_ref for update;
  if v_status is null then raise exception 'no_such_record'; end if;
  if v_status = 'check_in_flight' then raise exception 'id_copy_busy'; end if;
  -- Mirrors _shared/manual.ts CLIENT_ID_COPY_FROM: the statuses an application has while it is still
  -- the client's turn. After a manual verification, a check or a withdrawal the copy is the staff's.
  if v_status not in ('consent_confirmed', 'consent_registered', 'idv_in_progress', 'idv_passed',
                      'idv_failed', 'idv_unavailable', 'manual_required', 'idv_waived') then
    raise exception 'id_copy_locked';
  end if;
  if v_prev_front is not null then raise exception 'id_copy_present'; end if;

  update credit_checks set
    id_document_path = p_front_path, id_document_type = p_front_type, id_document_bytes = p_front_bytes,
    id_document_sha256 = p_front_sha256,
    id_document_uploaded_by = null, id_document_uploaded_at = now(), id_document_source = 'client',
    id_document_back_path = p_back_path, id_document_back_type = p_back_type, id_document_back_bytes = p_back_bytes,
    id_document_back_sha256 = p_back_sha256,
    audit = audit || jsonb_build_object(
      'at', (extract(epoch from now()) * 1000)::bigint,
      'event', 'Client''s ID copy attached by the client on the online form'
        || case when p_back_path is not null then ' (front and back)' else '' end)
  where ref = p_ref;
end $$;

revoke all on function public.attach_id_copy_client(text, text, text, int, text, text, text, int, text)
  from public, anon, authenticated;
grant execute on function public.attach_id_copy_client(text, text, text, int, text, text, text, int, text)
  to service_role;

-- ------------------------------------------------------------
-- 4. Opening the back of the card is logged as such
-- ------------------------------------------------------------
alter table public.report_access_log drop constraint if exists report_access_log_action_check;
alter table public.report_access_log add constraint report_access_log_action_check
  check (action in ('view', 'download_pdf', 'view_raw', 'view_id_document', 'view_id_document_back',
                    'view_signed_consent_form', 'view_client_photo', 'download_form'));

commit;

-- ------------------------------------------------------------
-- Verify (run separately, AFTER the block above):
--
--   select column_name from information_schema.columns
--    where table_schema = 'public' and table_name = 'credit_checks'
--      and (column_name like 'id_document_back%' or column_name = 'id_document_source') order by 1;   -- five rows
--   select proname, pg_get_function_result(oid) from pg_proc where proname like 'attach_id_copy%';     -- two rows: text[] and void
--   select has_function_privilege('anon', 'public.attach_id_copy_client(text, text, text, int, text, text, text, int, text)', 'execute'); -- false
--   select count(*) from credit_checks where id_document_path is not null and id_document_source is null; -- 0
-- ------------------------------------------------------------
