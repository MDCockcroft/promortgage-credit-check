-- Tests for 20261003_one_phone_one_person.sql. Run by run-local.sh after every migration.
-- Everything here is rolled back, so no record is left behind for the other test files.
begin;

create function pg_temp.mk(p_ref text, p_person text, p_cell text, p_confirmed boolean, p_verified text default null)
returns void language sql as $$
  insert into credit_checks (ref, status, first_names, surname, id_type, id_number, mm_person_id, email, cell, street, suburb, city,
      province, postal_code, employment_status, marital_status, consent_confirmed_at, idv_passed_at, manual_verified_at)
  values (p_ref, 'awaiting_otp', 'T', 'T', 'said', p_person, p_person, 't@x', p_cell, 's', 's', 'c', 'p', '0000', 'e', 'm',
      case when p_confirmed then now() end,
      case when p_verified = 'questions' then now() end,
      case when p_verified = 'manual' then now() end)
$$;

do $$
begin
  -- Person A confirmed with phone 1; person B verified by the questions with phone 2; person C verified manually with phone 3.
  perform pg_temp.mk('PM-L1', '9001010000001', '0821111111', true);
  perform pg_temp.mk('PM-L2', '9001010000002', '0822222222', true, 'questions');
  perform pg_temp.mk('PM-L3', '9001010000003', '0823333333', true, 'manual');

  -- 1. The same phone for the same person again: fine (any spelling of the number).
  perform pg_temp.mk('PM-L4', '9001010000001', '+27 82 111 1111', true);

  -- 2. The same phone CONFIRMED for a different person: the database refuses, whatever the spelling.
  begin
    perform pg_temp.mk('PM-L5', '9001010000009', '082 111 1111', true);
    raise exception 'a phone was confirmed for a second person';
  exception when exclusion_violation then null;
  end;

  -- 3. Not yet confirmed: no link is made (typing someone's number locks nothing)...
  perform pg_temp.mk('PM-L6', '9001010000009', '0821111111', false);
  -- ...but confirming it is refused: this is the two-forms-then-two-codes race, closed by the constraint.
  begin
    update credit_checks set consent_confirmed_at = now() where ref = 'PM-L6';
    raise exception 'a pending application was confirmed on a phone linked to someone else';
  exception when exclusion_violation then null;
  end;

  -- 4. link_conflict: what mm-client asks before accepting a form.
  if link_conflict('9001010000009', '0821111111') is distinct from 'cell_linked' then
    raise exception 'T15 FAIL: a phone linked to A was offered to another person: %', link_conflict('9001010000009', '0821111111'); end if;
  if link_conflict('9001010000009', '+27821111111') is distinct from 'cell_linked' then
    raise exception 'T15 FAIL: another spelling of the same number slipped through'; end if;
  if link_conflict('9001010000001', '0821111111') is not null then
    raise exception 'T15 FAIL: A was refused their own phone'; end if;
  -- A's identity is not verified yet, so A may still use another phone...
  if link_conflict('9001010000001', '0829999999') is not null then
    raise exception 'T15 FAIL: an unverified ID number was tied to a phone'; end if;
  -- ...but B (verified by the questions) and C (verified manually) are tied to theirs.
  if link_conflict('9001010000002', '0829999999') is distinct from 'id_linked' then
    raise exception 'T15 FAIL: a verified ID number was accepted on another phone (questions)'; end if;
  if link_conflict('9001010000003', '0829999999') is distinct from 'id_linked' then
    raise exception 'T15 FAIL: a verified ID number was accepted on another phone (manual)'; end if;
  if link_conflict('9001010000002', '0822222222') is not null then
    raise exception 'T15 FAIL: B was refused their own phone'; end if;
  -- A new person on a new phone, and input that submit itself rejects: no conflict reported here.
  if link_conflict('9001010000008', '0828888888') is not null or link_conflict('9001010000008', 'not a number') is not null
     or link_conflict('', '0821111111') is not null or link_conflict(null, null) is not null then
    raise exception 'T15 FAIL: a conflict was reported where there is none'; end if;

  -- 5. Deleting the earlier record frees the link (the only release there is).
  delete from credit_checks where ref in ('PM-L1', 'PM-L4');
  if link_conflict('9001010000009', '0821111111') is not null then
    raise exception 'T15 FAIL: the link outlived the records that made it'; end if;

  -- 6. Server-only.
  if has_function_privilege('anon', 'public.link_conflict(text,text)', 'execute')
     or has_function_privilege('authenticated', 'public.link_conflict(text,text)', 'execute')
     or not has_function_privilege('service_role', 'public.link_conflict(text,text)', 'execute') then
    raise exception 'T15 FAIL: link_conflict is not server-only';
  end if;

  raise notice 'T15 ok: one cellphone, one person - enforced at confirmation by the database, asked before submit, freed only by deleting';
end $$;

rollback;
