-- ============================================================
-- Pro Mortgage credit-check — one cellphone, one person
-- (apply AFTER 20261002_manual_consent_form.sql; can be applied before or after the mm-client deploy)
-- Idempotent: safe to re-run. Paste into Supabase → SQL Editor → Run. One transaction.
-- ============================================================
-- Why (Michael, 2026-10-01): a cellphone number may request a credit check for ONE person only,
-- and once that person's identity is verified, their ID number belongs to that cellphone number.
-- It stops one phone being used to run checks on several people.
--
-- The link is read from the applications themselves - there is no separate list of phone/ID
-- pairs - so deleting a client's record also frees the link. Nobody can release a link any other
-- way (decided 2026-10-01): a shared phone or a changed number means an administrator deletes the
-- earlier record first.
--
-- Only a PROVEN step makes a link, so nobody can lock up someone else's number or ID by typing it:
--   - a phone is linked to an ID number once its SMS code has been entered (consent confirmed);
--   - an ID number is tied to a phone once identity is verified (questions passed, or manually).
-- ============================================================
-- What this does:
--   1. A constraint on credit_checks: among applications whose SMS code was entered, one cellphone
--      number (in any spelling: 082…, +27 82…) never appears with two different ID numbers. The
--      database refuses the second confirmation itself, even if two arrive in the same instant.
--   2. link_conflict(): the question mm-client asks before a form is accepted and before any SMS is
--      sent - 'cell_linked', 'id_linked', or nothing. Service role only.
-- ============================================================

begin;

create extension if not exists btree_gist with schema extensions;

-- ------------------------------------------------------------
-- 0. Existing data must already obey the rule, or the constraint cannot be added.
-- ------------------------------------------------------------
do $$
declare v_bad text;
begin
  select string_agg(refs, ' | ') into v_bad from (
    select string_agg(ref, ', ' order by created_at) as refs
      from credit_checks
     where consent_confirmed_at is not null and mm_person_id is not null and public.sa_cell_e164(cell) is not null
     group by public.sa_cell_e164(cell)
    having count(distinct mm_person_id) > 1
     limit 5) t;
  if v_bad is not null then
    raise exception 'STOP: these applications share a cellphone number across different ID numbers: %. Delete the ones that are test data (admin page), then run this file again.', v_bad;
  end if;
end $$;

-- ------------------------------------------------------------
-- 1. One cellphone number, one person - among applications whose SMS code was entered
-- ------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'one_person_per_cellphone' and conrelid = 'public.credit_checks'::regclass) then
    alter table public.credit_checks add constraint one_person_per_cellphone
      exclude using gist (public.sa_cell_e164(cell) with =, mm_person_id with <>)
      where (consent_confirmed_at is not null);
  end if;
end $$;

-- ------------------------------------------------------------
-- 2. The question asked before a form is accepted (and before any SMS is sent)
--    'cell_linked' - this phone already confirmed an application for a DIFFERENT ID number
--    'id_linked'   - this ID number was identity-verified with a DIFFERENT phone
--    null          - no conflict (or the number is not a valid SA cellphone: submit says so)
-- ------------------------------------------------------------
create or replace function public.link_conflict(p_person text, p_cell text)
returns text
language plpgsql stable security definer set search_path = public, extensions
as $$
declare
  v_cell   text := public.sa_cell_e164(p_cell);
  v_person text := nullif(btrim(coalesce(p_person, '')), '');
begin
  if v_cell is null or v_person is null then
    return null;
  end if;
  if exists (select 1 from credit_checks c
              where public.sa_cell_e164(c.cell) = v_cell
                and c.mm_person_id <> v_person
                and c.consent_confirmed_at is not null) then
    return 'cell_linked';
  end if;
  if exists (select 1 from credit_checks c
              where c.mm_person_id = v_person
                and public.sa_cell_e164(c.cell) <> v_cell
                and (c.idv_passed_at is not null or c.manual_verified_at is not null)) then
    return 'id_linked';
  end if;
  return null;
end $$;

revoke all on function public.link_conflict(text, text) from public, anon, authenticated;
grant execute on function public.link_conflict(text, text) to service_role;

commit;

-- ------------------------------------------------------------
-- Verify (run separately, AFTER the block above):
--
--   select conname from pg_constraint where conname = 'one_person_per_cellphone';   -- one row
--   select has_function_privilege('anon', 'public.link_conflict(text,text)', 'execute');   -- false
-- ------------------------------------------------------------
