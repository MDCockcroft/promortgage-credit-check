-- ============================================================
-- Pro Mortgage credit-check — consultant roles and record ownership
-- (apply AFTER 20260929_manual_verification.sql)
-- Idempotent: safe to re-run. Paste into Supabase → SQL Editor → Run.
-- The whole file runs in ONE transaction: if any statement fails, nothing changes.
-- ============================================================
-- Why: ~11 consultants will use the system and must not see each other's clients at all
-- (confirmed 2026-09-29; quotation ARB-Q-2026-002 s2.1: Administrator + Consultant "own clients
-- only"). Until now every signed-in user could read every record, report and ID copy.
--
-- DEPLOY ORDER: safe to apply FIRST, on its own. On the first run every confirmed, usable login
-- that already exists becomes an administrator (today that is one account), and administrators
-- see everything — so nothing changes for anyone until consultant accounts are created.
-- CHECK FIRST: Authentication -> Users must show only the logins you expect.
-- After this file, every OLDER .sql file refuses to run (they would reopen access). The Edge Functions use the service
-- role and are NOT restricted by these rules; their own ownership checks ship next (stage 2) and
-- must be live before the first consultant account is created.
-- ============================================================
-- What this does:
--   1. staff_members: who is staff, their role (admin | consultant), whether they are active, and
--      their personal link code. Written ONLY by the service role — never by the user themselves
--      (staff_profiles is self-editable, so the role cannot live there).
--   2. credit_checks.consultant_id: the consultant a record belongs to (null = unassigned).
--   3. Access rules: a consultant reads only their own records; an administrator reads all; a
--      deactivated or unknown login reads nothing. The same rule covers consent events, manual
--      verification evidence, access logs, vendor call logs, live-refresh signals, stored credit
--      reports and stored ID copies.
--   4. Functions (service role only): attach_consultant (a form submitted through a personal
--      link), assign_consultant (administrator hands out an unassigned record, or a leaver's),
--      upsert_staff_member (create / change / deactivate, never removing the last administrator),
--      consultant_by_code (the first name shown on the form).
-- ============================================================

begin;

-- Is this the very first run? Decided BEFORE the table is created, and kept for this transaction
-- only. An empty table is not "first run": it can become empty later, and must never re-seed.
select set_config('pm.roles_first_run', case when to_regclass('public.staff_members') is null then '1' else '0' end, true);

-- ------------------------------------------------------------
-- 1. Staff membership
-- ------------------------------------------------------------
create table if not exists public.staff_members (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  role       text not null check (role in ('admin', 'consultant')),
  active     boolean not null default true,
  link_code  text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid
);
alter table public.staff_members enable row level security;
revoke all on table public.staff_members from anon;
revoke insert, update, delete on table public.staff_members from authenticated;

-- Link codes: 8 characters, no look-alikes (0/o, 1/l/i), not guessable from a name. 31^8 is about
-- 850 billion, so guessing a live one through the public name lookup is not practical.
create or replace function public.new_link_code()
returns text
language plpgsql security definer set search_path = public, extensions, pg_temp
as $$
declare
  alphabet constant text := 'abcdefghjkmnpqrstuvwxyz23456789';
  v text;
  b bytea;
begin
  loop
    b := gen_random_bytes(8);
    v := '';
    for i in 0..7 loop
      v := v || substr(alphabet, (get_byte(b, i) % length(alphabet)) + 1, 1);
    end loop;
    exit when not exists (select 1 from staff_members where link_code = v);
  end loop;
  return v;
end $$;

-- FIRST RUN ONLY: the logins that already use the system become administrators, so applying this
-- file changes nothing for them. Only real, confirmed, usable logins - never an anonymous, banned,
-- deleted or unconfirmed one. Never on a re-run, even if the table has been emptied since: a
-- login created later is given its role deliberately, through upsert_staff_member.
-- BEFORE APPLYING: check Authentication -> Users shows only the logins you expect.
do $$
begin
  if current_setting('pm.roles_first_run', true) = '1' then
    insert into public.staff_members (user_id, role, link_code)
    select u.id, 'admin', public.new_link_code()
      from auth.users u
     where u.email_confirmed_at is not null
       and u.deleted_at is null
       and coalesce(u.is_anonymous, false) = false
       and (u.banned_until is null or u.banned_until < now());
    -- Nobody to make an administrator: stop, rather than install rules that lock everyone out.
    if not exists (select 1 from public.staff_members) then
      raise exception 'STOP: no confirmed login exists to become the administrator. Create the first staff login, then run this file again.';
    end if;
  end if;
end $$;

-- There is always at least one active administrator - whatever the route (the functions below,
-- the SQL editor, or deleting a login in the dashboard, which cascades to this table).
create or replace function public.staff_members_keep_admin()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if not exists (select 1 from staff_members where role = 'admin' and active) then
    raise exception 'last_admin' using errcode = '22023',
      hint = 'The system must keep one active administrator. Make someone else an administrator first.';
  end if;
  return null;
end $$;
drop trigger if exists staff_members_keep_admin on public.staff_members;
create trigger staff_members_keep_admin
  after update or delete on public.staff_members
  for each statement execute function public.staff_members_keep_admin();

-- ------------------------------------------------------------
-- 2. Ownership of a record (the column comes first: the functions below are checked against it
--    when they are created)
-- ------------------------------------------------------------
alter table public.credit_checks
  -- restrict: a login that still has clients cannot be deleted (deactivate it, reassign, then delete)
  add column if not exists consultant_id uuid references auth.users(id) on delete restrict,
  add column if not exists assigned_at   timestamptz,
  add column if not exists assigned_by   uuid;
create index if not exists credit_checks_consultant_idx on public.credit_checks (consultant_id, created_at desc);

-- ------------------------------------------------------------
-- 3. Who is asking? (security definer: they read staff_members / credit_checks past the very
--    rules they are used in, so the rules cannot recurse)
-- ------------------------------------------------------------
create or replace function public.my_staff_role()
returns text
language sql stable security definer set search_path = public, pg_temp
as $$
  select role from staff_members where user_id = auth.uid() and active
$$;

create or replace function public.is_staff()
returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select exists (select 1 from staff_members where user_id = auth.uid() and active)
$$;

create or replace function public.is_admin()
returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select exists (select 1 from staff_members where user_id = auth.uid() and active and role = 'admin')
$$;

-- May the caller see the record with this reference? Administrators: any reference, including
-- ones whose record was deleted. Consultants: only a living record assigned to them.
create or replace function public.can_see_ref(p_ref text)
returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select public.is_admin()
      or (p_ref is not null and public.is_staff() and exists (
            select 1 from credit_checks where ref = p_ref and consultant_id = auth.uid()))
$$;

drop policy if exists staff_read on public.staff_members;
create policy staff_read on public.staff_members for select to authenticated
  using (user_id = auth.uid() or (select public.is_admin()));

-- ------------------------------------------------------------
-- 4. Reading records
-- ------------------------------------------------------------
-- staff_all let any signed-in user do anything the grants allowed. Staff have had no
-- insert/update/delete grant since 20260926/20260927, so reading is all that is left to govern.
drop policy if exists staff_all on public.credit_checks;
drop policy if exists staff_read_own on public.credit_checks;
create policy staff_read_own on public.credit_checks for select to authenticated
  using ((select public.is_admin()) or (consultant_id = auth.uid() and (select public.is_staff())));

-- ------------------------------------------------------------
-- 5. Everything that hangs off a record follows the record
-- ------------------------------------------------------------
drop policy if exists staff_read on public.consent_events;
create policy staff_read on public.consent_events for select to authenticated
  using (public.can_see_ref(ref));

drop policy if exists staff_read on public.manual_verifications;
create policy staff_read on public.manual_verifications for select to authenticated
  using (public.can_see_ref(ref));

drop policy if exists staff_read on public.mm_api_log;
create policy staff_read on public.mm_api_log for select to authenticated
  using (public.can_see_ref(ref));

drop policy if exists staff_read on public.report_access_log;
create policy staff_read on public.report_access_log for select to authenticated
  using (public.can_see_ref(ref));
drop policy if exists staff_insert_own on public.report_access_log;
create policy staff_insert_own on public.report_access_log for insert to authenticated
  with check (user_id = auth.uid() and public.can_see_ref(ref));

-- Colleagues' names appear in a record's access log, so profiles stay readable by active staff
-- (name, work email, cellphone, branch - no client information). Still self-editable only.
drop policy if exists staff_read on public.staff_profiles;
create policy staff_read on public.staff_profiles for select to authenticated
  using ((select public.is_staff()));
drop policy if exists staff_own on public.staff_profiles;
create policy staff_own on public.staff_profiles for all to authenticated
  using (user_id = auth.uid() and (select public.is_staff()))
  with check (user_id = auth.uid() and (select public.is_staff()));

-- Live-refresh signals carry the owner themselves: a signal for a DELETED record has no record
-- left to look the owner up in.
alter table public.credit_check_signals add column if not exists consultant_id uuid;

create or replace function public.signal_credit_check_change()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  insert into credit_check_signals (ref, status, op, consultant_id)
  values (coalesce(new.ref, old.ref),
          case when tg_op = 'DELETE' then null else new.status end,
          lower(tg_op),
          case when tg_op = 'DELETE' then old.consultant_id else new.consultant_id end);
  return null;
end $$;

drop policy if exists staff_read on public.credit_check_signals;
create policy staff_read on public.credit_check_signals for select to authenticated
  using ((select public.is_admin()) or (consultant_id = auth.uid() and (select public.is_staff())));

-- Stored files: the first folder of the object name is the record's reference.
drop policy if exists "credit-reports staff read" on storage.objects;
create policy "credit-reports staff read" on storage.objects
  for select to authenticated
  using (bucket_id = 'credit-reports' and public.can_see_ref(split_part(name, '/', 1)));

drop policy if exists "id-documents staff read" on storage.objects;
create policy "id-documents staff read" on storage.objects
  for select to authenticated
  using (bucket_id = 'id-documents' and public.can_see_ref(split_part(name, '/', 1)));

-- ------------------------------------------------------------
-- 6. Changing ownership and membership (service role only)
-- ------------------------------------------------------------
-- The form was submitted through a consultant's personal link. Attaches only an UNASSIGNED
-- record, only to an ACTIVE member. Returns true when attached.
create or replace function public.attach_consultant(p_ref text, p_code text)
returns boolean
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_user uuid;
  v_name text;
  n int;
begin
  if p_code is null or p_code !~ '^[a-z0-9]{8}$' then return false; end if;
  select m.user_id, p.full_name into v_user, v_name
    from staff_members m left join staff_profiles p on p.user_id = m.user_id
   where m.link_code = p_code and m.active;
  if v_user is null then
    -- Say so on the record: otherwise it just turns up unassigned and nobody knows why.
    update credit_checks set audit = audit || jsonb_build_object(
        'at', (extract(epoch from now()) * 1000)::bigint,
        'event', 'Arrived through a personal link that is not active (' || p_code || ') - not assigned to anyone')
     where ref = p_ref and consultant_id is null;
    return false;
  end if;

  update credit_checks set
    consultant_id = v_user,
    assigned_at = now(),
    audit = audit || jsonb_build_object(
      'at', (extract(epoch from now()) * 1000)::bigint,
      'event', 'Received through the personal link of ' || coalesce(nullif(v_name, ''), 'a consultant'))
  where ref = p_ref and consultant_id is null;
  get diagnostics n = row_count;
  return n = 1;
end $$;

-- An administrator assigns a record. Clients do not move between consultants: allowed only when
-- the record is unassigned, or its consultant is no longer active (has left).
-- Returns 'ok' | 'not_found' | 'not_staff' | 'already_assigned'.
create or replace function public.assign_consultant(p_ref text, p_consultant uuid, p_by uuid, p_by_label text)
returns text
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_current uuid;
  v_found boolean;
  v_name text;
begin
  select true, consultant_id into v_found, v_current from credit_checks where ref = p_ref for update;
  if v_found is null then return 'not_found'; end if;
  if not exists (select 1 from staff_members where user_id = p_consultant and active) then
    return 'not_staff';
  end if;
  if v_current is not null and v_current <> p_consultant
     and exists (select 1 from staff_members where user_id = v_current and active) then
    return 'already_assigned';
  end if;
  if v_current = p_consultant then return 'ok'; end if;

  select full_name into v_name from staff_profiles where user_id = p_consultant;
  update credit_checks set
    consultant_id = p_consultant,
    assigned_at = now(),
    assigned_by = p_by,
    audit = audit || jsonb_build_object(
      'at', (extract(epoch from now()) * 1000)::bigint,
      'event', case when v_current is null then 'Assigned to ' else 'Reassigned (previous consultant no longer active) to ' end
               || coalesce(nullif(v_name, ''), 'a consultant') || ' by ' || coalesce(p_by_label, 'an administrator'))
  where ref = p_ref;
  return 'ok';
end $$;

-- Create, change or deactivate a staff member. The system must always keep one active
-- administrator. Returns the member, or raises 'last_admin'.
create or replace function public.upsert_staff_member(p_user uuid, p_role text, p_active boolean, p_by uuid)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  r staff_members%rowtype;
begin
  if p_role not in ('admin', 'consultant') then
    raise exception 'invalid_role' using errcode = '22023';
  end if;
  -- One membership change at a time, so two administrators cannot demote each other at once.
  perform pg_advisory_xact_lock(hashtext('staff_members'));

  if (p_role <> 'admin' or not p_active)
     and exists (select 1 from staff_members where user_id = p_user and role = 'admin' and active)
     and not exists (select 1 from staff_members where user_id <> p_user and role = 'admin' and active) then
    raise exception 'last_admin' using errcode = '22023';
  end if;

  insert into staff_members (user_id, role, active, link_code, updated_by)
  values (p_user, p_role, p_active, public.new_link_code(), p_by)
  on conflict (user_id) do update set
    role = excluded.role, active = excluded.active, updated_at = now(), updated_by = excluded.updated_by
  returning * into r;
  return to_jsonb(r);
end $$;

-- The name the form shows for a personal link. First name only; null for an unknown or inactive code.
create or replace function public.consultant_by_code(p_code text)
returns text
language sql stable security definer set search_path = public, pg_temp
as $$
  select coalesce(nullif(split_part(btrim(p.full_name), ' ', 1), ''), 'your consultant')
    from staff_members m left join staff_profiles p on p.user_id = m.user_id
   where p_code ~ '^[a-z0-9]{8}$' and m.link_code = p_code and m.active
$$;

-- ------------------------------------------------------------
-- Grants (re-stated after every create or replace)
-- ------------------------------------------------------------
revoke all on function public.my_staff_role() from public, anon;
revoke all on function public.is_staff() from public, anon;
revoke all on function public.is_admin() from public, anon;
revoke all on function public.can_see_ref(text) from public, anon;
grant execute on function public.my_staff_role() to authenticated, service_role;
grant execute on function public.is_staff() to authenticated, service_role;
grant execute on function public.is_admin() to authenticated, service_role;
grant execute on function public.can_see_ref(text) to authenticated, service_role;

revoke all on function public.staff_members_keep_admin() from public, anon, authenticated;
revoke all on function public.new_link_code() from public, anon, authenticated;
revoke all on function public.signal_credit_check_change() from public, anon, authenticated;
revoke all on function public.attach_consultant(text, text) from public, anon, authenticated;
revoke all on function public.assign_consultant(text, uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.upsert_staff_member(uuid, text, boolean, uuid) from public, anon, authenticated;
revoke all on function public.consultant_by_code(text) from public, anon, authenticated;
grant execute on function public.new_link_code() to service_role;
grant execute on function public.attach_consultant(text, text) to service_role;
grant execute on function public.assign_consultant(text, uuid, uuid, text) to service_role;
grant execute on function public.upsert_staff_member(uuid, text, boolean, uuid) to service_role;
grant execute on function public.consultant_by_code(text) to service_role;

commit;
