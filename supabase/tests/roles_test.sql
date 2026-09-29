-- Consultant roles and record ownership (migration 20260930). Run by run-local.sh on a throwaway
-- database. Users: A = seeded administrator, B and C = consultants, D = consultant who left
-- (deactivated), E = a login with no membership.
\set ON_ERROR_STOP 1
\set A '00000000-0000-0000-0000-00000000000a'
\set B '00000000-0000-0000-0000-00000000000b'
\set C '00000000-0000-0000-0000-00000000000c'
\set D '00000000-0000-0000-0000-00000000000d'
\set E '00000000-0000-0000-0000-00000000000e'

-- ---------- T0: what the migration itself did ----------
do $$
declare m record;
begin
  select * into m from staff_members where user_id = '00000000-0000-0000-0000-00000000000a';
  if m.role is distinct from 'admin' or not m.active or m.link_code !~ '^[a-hj-km-np-z2-9]{6}$' then
    raise exception 'T0 FAIL: existing login not seeded as admin: %', m; end if;
  if exists (select 1 from staff_members where user_id = '00000000-0000-0000-0000-00000000000e') then
    raise exception 'T0 FAIL: a re-run promoted a login created later'; end if;
  if exists (select 1 from pg_policies where tablename = 'credit_checks' and policyname = 'staff_all') then
    raise exception 'T0 FAIL: staff_all still exists'; end if;
  if exists (select 1 from pg_policies where schemaname in ('public', 'storage') and roles @> '{authenticated}'
               and qual = 'true') then
    raise exception 'T0 FAIL: a policy still lets every signed-in user read'; end if;
  raise notice 'T0 ok: seed made the existing login an admin; re-run promoted nobody; no open policy left';
end $$;

-- ---------- fixtures ----------
drop schema if exists t cascade;
create schema t;
create function t.rec(p_ref text, p_consultant uuid) returns void language sql as $$
  insert into credit_checks (ref, status, first_names, surname, id_type, email, cell, street, suburb, city,
    province, postal_code, employment_status, marital_status, consent_registered_at, consultant_id)
  values (p_ref, 'consent_registered', 'T', 'T', 'said', 't@x', '0820000000', 's', 's', 'c', 'p', '0000', 'e', 'm', now(), p_consultant)
$$;
insert into auth.users (id, email) values (:'B', 'b@test'), (:'C', 'c@test'), (:'D', 'd@test');
select upsert_staff_member(:'B', 'consultant', true, :'A') \gset b_
select upsert_staff_member(:'C', 'consultant', true, :'A') \gset c_
select upsert_staff_member(:'D', 'consultant', true, :'A') \gset d_
insert into staff_profiles (user_id, full_name, email) values
  (:'A', 'Ada Admin', 'a@test'), (:'B', 'Bongi Dlamini', 'b@test'), (:'C', 'Carl Botha', 'c@test');
select t.rec('PM-R1', :'B'), t.rec('PM-R2', :'C'), t.rec('PM-R3', null), t.rec('PM-R4', :'D');
select upsert_staff_member(:'D', 'consultant', false, :'A') \gset d2_
insert into consent_events (ref, event) values ('PM-R1', 'registered'), ('PM-R2', 'registered'), ('PM-GONE', 'deleted');
insert into manual_verifications (ref, verified_by, verified_by_label, attestation_version, attestation_text, attestation_sha256,
    document_path, document_type, document_bytes, document_sha256)
  values ('PM-R1', :'B', 'b', 'v', 't', 'h', 'PM-R1/a.png', 'image/png', 1, 'h'),
         ('PM-R2', :'C', 'c', 'v', 't', 'h', 'PM-R2/a.png', 'image/png', 1, 'h');
insert into mm_api_log (ref, api, method, path_redacted) values ('PM-R1', 'credit', 'POST', '/x'), ('PM-R2', 'credit', 'POST', '/x'), (null, 'consent', 'GET', '/ConsentTypes');
insert into report_access_log (ref, user_id, action) values ('PM-R1', :'B', 'view'), ('PM-R2', :'C', 'view');
insert into storage.objects (bucket_id, name) values
  ('credit-reports', 'PM-R1/report.pdf'), ('credit-reports', 'PM-R2/report.pdf'), ('credit-reports', 'PM-R4/report.pdf'),
  ('id-documents', 'PM-R1/id.png'), ('id-documents', 'PM-R2/id.png'), ('other-bucket', 'PM-R1/x');

-- What the signed-in user can see, as one row of counts.
create function t.seen() returns text language sql as $$
  select format('checks=%s[%s] events=%s evidence=%s apilog=%s access=%s signals=%s reports=%s ids=%s other=%s members=%s profiles=%s',
    (select count(*) from credit_checks), (select coalesce(string_agg(ref, ',' order by ref), '') from credit_checks),
    (select count(*) from consent_events), (select count(*) from manual_verifications), (select count(*) from mm_api_log),
    (select count(*) from report_access_log), (select count(distinct ref) from credit_check_signals),
    (select count(*) from storage.objects where bucket_id = 'credit-reports'),
    (select count(*) from storage.objects where bucket_id = 'id-documents'),
    (select count(*) from storage.objects where bucket_id = 'other-bucket'),
    (select count(*) from staff_members), (select count(*) from staff_profiles))
$$;
grant usage on schema t to authenticated, anon;
grant execute on function t.seen() to authenticated, anon;

-- ---------- T1-T5: who sees what ----------
select set_config('request.jwt.claim.sub', :'B', false) \gset x_
set role authenticated;
do $$ declare s text := t.seen(); begin
  if s <> 'checks=1[PM-R1] events=1 evidence=1 apilog=1 access=1 signals=1 reports=1 ids=1 other=0 members=1 profiles=3' then
    raise exception 'T1 FAIL consultant B sees: %', s; end if;
  raise notice 'T1 ok: consultant B sees only their own record and its files: %', s;
end $$;
reset role;

select set_config('request.jwt.claim.sub', :'C', false) \gset x_
set role authenticated;
do $$ declare s text := t.seen(); begin
  if s <> 'checks=1[PM-R2] events=1 evidence=1 apilog=1 access=1 signals=1 reports=1 ids=1 other=0 members=1 profiles=3' then
    raise exception 'T2 FAIL consultant C sees: %', s; end if;
  -- the access log: own record and own name only
  insert into report_access_log (ref, user_id, action) values ('PM-R2', auth.uid(), 'view');
  begin insert into report_access_log (ref, user_id, action) values ('PM-R1', auth.uid(), 'view');
    raise exception 'T2 FAIL: logged access to a colleague''s record'; exception when insufficient_privilege then null; end;
  begin insert into report_access_log (ref, user_id, action) values ('PM-R2', '00000000-0000-0000-0000-00000000000b', 'view');
    raise exception 'T2 FAIL: logged access in a colleague''s name'; exception when insufficient_privilege then null; end;
  if can_see_ref('PM-R1') or not can_see_ref('PM-R2') or can_see_ref(null) or can_see_ref('PM-GONE') then
    raise exception 'T2 FAIL: can_see_ref'; end if;
  raise notice 'T2 ok: consultant C sees only their own; cannot log against a colleague''s record or name';
end $$;
reset role;

select set_config('request.jwt.claim.sub', :'A', false) \gset x_
set role authenticated;
do $$ declare s text := t.seen(); begin
  if s <> 'checks=4[PM-R1,PM-R2,PM-R3,PM-R4] events=3 evidence=2 apilog=3 access=3 signals=4 reports=3 ids=2 other=0 members=4 profiles=3' then
    raise exception 'T3 FAIL admin sees: %', s; end if;
  raise notice 'T3 ok: administrator sees everything, including unassigned and deleted references';
end $$;
reset role;

select set_config('request.jwt.claim.sub', :'D', false) \gset x_
set role authenticated;
do $$ declare s text := t.seen(); begin
  if s <> 'checks=0[] events=0 evidence=0 apilog=0 access=0 signals=0 reports=0 ids=0 other=0 members=1 profiles=0' then
    raise exception 'T4 FAIL deactivated D sees: %', s; end if;
  begin insert into report_access_log (ref, user_id, action) values ('PM-R4', auth.uid(), 'view');
    raise exception 'T4 FAIL: deactivated login wrote an access log'; exception when insufficient_privilege then null; end;
  begin insert into staff_profiles (user_id, full_name, email) values (auth.uid(), 'D', 'd@test');
    raise exception 'T4 FAIL: deactivated login wrote a profile'; exception when insufficient_privilege then null; end;
  raise notice 'T4 ok: a deactivated consultant sees nothing, not even their former clients';
end $$;
reset role;

select set_config('request.jwt.claim.sub', :'E', false) \gset x_
set role authenticated;
do $$ declare s text := t.seen(); begin
  if s <> 'checks=0[] events=0 evidence=0 apilog=0 access=0 signals=0 reports=0 ids=0 other=0 members=0 profiles=0' then
    raise exception 'T5 FAIL unknown login sees: %', s; end if;
  raise notice 'T5 ok: a login with no membership sees nothing';
end $$;

-- ---------- T6: nobody can promote themselves or move a record ----------
select set_config('request.jwt.claim.sub', :'B', false) \gset x_
do $$ begin
  begin update staff_members set role = 'admin' where user_id = auth.uid(); raise exception 'T6 FAIL: self-promotion';
    exception when insufficient_privilege then null; end;
  begin insert into staff_members (user_id, role) values ('00000000-0000-0000-0000-00000000000e', 'admin'); raise exception 'T6 FAIL: insert member';
    exception when insufficient_privilege then null; end;
  begin delete from staff_members; raise exception 'T6 FAIL: delete members'; exception when insufficient_privilege then null; end;
  begin update credit_checks set consultant_id = auth.uid() where ref = 'PM-R2'; raise exception 'T6 FAIL: took a colleague''s record';
    exception when insufficient_privilege then null; end;
  begin perform upsert_staff_member(auth.uid(), 'admin', true, auth.uid()); raise exception 'T6 FAIL: upsert_staff_member';
    exception when insufficient_privilege then null; end;
  begin perform assign_consultant('PM-R3', auth.uid(), auth.uid(), 'b'); raise exception 'T6 FAIL: assign_consultant';
    exception when insufficient_privilege then null; end;
  begin perform attach_consultant('PM-R3', 'abcdef'); raise exception 'T6 FAIL: attach_consultant';
    exception when insufficient_privilege then null; end;
  begin perform consultant_by_code('abcdef'); raise exception 'T6 FAIL: consultant_by_code';
    exception when insufficient_privilege then null; end;
  begin perform new_link_code(); raise exception 'T6 FAIL: new_link_code'; exception when insufficient_privilege then null; end;
  raise notice 'T6 ok: a consultant cannot promote themselves, edit membership, take a record or call the admin functions';
end $$;
reset role;
set role anon;
do $$ begin
  begin perform 1 from staff_members; raise exception 'T6 FAIL: anon read members'; exception when insufficient_privilege then null; end;
  begin perform is_admin(); raise exception 'T6 FAIL: anon is_admin'; exception when insufficient_privilege then null; end;
  begin perform can_see_ref('PM-R1'); raise exception 'T6 FAIL: anon can_see_ref'; exception when insufficient_privilege then null; end;
  begin perform consultant_by_code('abcdef'); raise exception 'T6 FAIL: anon consultant_by_code'; exception when insufficient_privilege then null; end;
  raise notice 'T6 ok: the public can read and call none of it';
end $$;
reset role;

-- ---------- T7-T9: the service role's functions ----------
select t.rec('PM-R5', null);
set role service_role;
do $$
declare
  b_code text; c_code text; d_code text; ev text; r text; m jsonb; old_code text;
begin
  select link_code into b_code from staff_members where user_id = '00000000-0000-0000-0000-00000000000b';
  select link_code into c_code from staff_members where user_id = '00000000-0000-0000-0000-00000000000c';
  select link_code into d_code from staff_members where user_id = '00000000-0000-0000-0000-00000000000d';

  -- T7 personal links
  if attach_consultant('PM-R5', upper(b_code)) or attach_consultant('PM-R5', b_code || 'x') or attach_consultant('PM-R5', null)
     or attach_consultant('PM-R5', d_code) or attach_consultant('PM-NOPE', b_code) then
    raise exception 'T7 FAIL: a bad, inactive or unknown link attached'; end if;
  if not attach_consultant('PM-R5', b_code) then raise exception 'T7 FAIL: a good link did not attach'; end if;
  if attach_consultant('PM-R5', c_code) then raise exception 'T7 FAIL: a second link took an assigned record'; end if;
  select audit -> -1 ->> 'event' into ev from credit_checks where ref = 'PM-R5' and consultant_id = '00000000-0000-0000-0000-00000000000b';
  if ev is distinct from 'Received through the personal link of Bongi Dlamini' then raise exception 'T7 FAIL: audit %', ev; end if;
  if consultant_by_code(b_code) <> 'Bongi' or consultant_by_code('zzzzzz') is not null or consultant_by_code(d_code) is not null
     or consultant_by_code('x') is not null then raise exception 'T7 FAIL: consultant_by_code'; end if;
  raise notice 'T7 ok: a personal link attaches an unassigned record once; bad, inactive and second links do nothing';

  -- T8 assignment by an administrator
  if assign_consultant('PM-NOPE', '00000000-0000-0000-0000-00000000000c', '00000000-0000-0000-0000-00000000000a', 'Ada') <> 'not_found'
     or assign_consultant('PM-R3', '00000000-0000-0000-0000-00000000000e', '00000000-0000-0000-0000-00000000000a', 'Ada') <> 'not_staff'
     or assign_consultant('PM-R3', '00000000-0000-0000-0000-00000000000d', '00000000-0000-0000-0000-00000000000a', 'Ada') <> 'not_staff'
     or assign_consultant('PM-R1', '00000000-0000-0000-0000-00000000000c', '00000000-0000-0000-0000-00000000000a', 'Ada') <> 'already_assigned' then
    raise exception 'T8 FAIL: a refusal was not refused'; end if;
  if (select consultant_id from credit_checks where ref = 'PM-R1') <> '00000000-0000-0000-0000-00000000000b' then
    raise exception 'T8 FAIL: an active consultant lost a client'; end if;
  if assign_consultant('PM-R3', '00000000-0000-0000-0000-00000000000c', '00000000-0000-0000-0000-00000000000a', 'Ada') <> 'ok'
     or assign_consultant('PM-R4', '00000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-00000000000a', 'Ada') <> 'ok' then
    raise exception 'T8 FAIL: a valid assignment was refused'; end if;
  select audit -> -1 ->> 'event' into ev from credit_checks where ref = 'PM-R4';
  if ev is distinct from 'Reassigned (previous consultant no longer active) to Bongi Dlamini by Ada' then raise exception 'T8 FAIL: audit %', ev; end if;
  raise notice 'T8 ok: unassigned and leavers'' records can be assigned; an active consultant''s clients cannot be moved';

  -- T9 membership
  begin perform upsert_staff_member('00000000-0000-0000-0000-00000000000a', 'consultant', true, null);
    raise exception 'T9 FAIL: demoted the last administrator'; exception when sqlstate '22023' then null; end;
  begin perform upsert_staff_member('00000000-0000-0000-0000-00000000000a', 'admin', false, null);
    raise exception 'T9 FAIL: deactivated the last administrator'; exception when sqlstate '22023' then null; end;
  begin perform upsert_staff_member('00000000-0000-0000-0000-00000000000b', 'owner', true, null);
    raise exception 'T9 FAIL: invalid role accepted'; exception when sqlstate '22023' then null; end;
  old_code := b_code;
  m := upsert_staff_member('00000000-0000-0000-0000-00000000000b', 'admin', true, '00000000-0000-0000-0000-00000000000a');
  if m ->> 'role' <> 'admin' or m ->> 'link_code' <> old_code then raise exception 'T9 FAIL: promote changed the link code: %', m; end if;
  m := upsert_staff_member('00000000-0000-0000-0000-00000000000a', 'consultant', true, '00000000-0000-0000-0000-00000000000b');
  if m ->> 'role' <> 'consultant' then raise exception 'T9 FAIL: could not demote once a second administrator exists'; end if;
  raise notice 'T9 ok: the last administrator cannot be removed; a link code survives a role change';
end $$;
reset role;

-- ---------- T10: a deleted record still signals its owner ----------
delete from credit_checks where ref = 'PM-R2';
select set_config('request.jwt.claim.sub', :'C', false) \gset x_
set role authenticated;
do $$ declare n int; begin
  select count(*) into n from credit_check_signals where ref = 'PM-R2' and op = 'delete';
  if n <> 1 then raise exception 'T10 FAIL: owner did not see the delete signal (%)', n; end if;
  if (select count(*) from credit_checks) <> 1 or (select string_agg(ref, ',') from credit_checks) <> 'PM-R3' then
    raise exception 'T10 FAIL: C should now see only the record assigned in T8'; end if;
  if (select count(*) from consent_events) <> 0 then raise exception 'T10 FAIL: events of a deleted record still visible to the consultant'; end if;
  raise notice 'T10 ok: the owner gets the delete signal; evidence of a deleted record is for administrators only';
end $$;
reset role;
