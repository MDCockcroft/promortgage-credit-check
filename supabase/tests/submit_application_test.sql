-- Tests for 20261005_submit_without_otp.sql. Run by run-local.sh after every migration.
-- Everything here is rolled back, so no record is left behind for the other test files.
begin;

insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000d1', 'link1@test'),
                                          ('00000000-0000-0000-0000-0000000000d2', 'link2@test');
select upsert_staff_member('00000000-0000-0000-0000-0000000000d1', 'consultant', true, '00000000-0000-0000-0000-00000000000a');
select upsert_staff_member('00000000-0000-0000-0000-0000000000d2', 'consultant', true, '00000000-0000-0000-0000-00000000000a');

do $$
declare
  c1 text := (select link_code from staff_members where user_id = '00000000-0000-0000-0000-0000000000d1');
  c2 text := (select link_code from staff_members where user_id = '00000000-0000-0000-0000-0000000000d2');
  p jsonb := jsonb_build_object(
    'idType', 'said', 'idNumber', '9302170340096', 'firstNames', 'T', 'surname', 'T', 'email', 't@x',
    'cell', '0821234567', 'street', 's', 'suburb', 's', 'city', 'c', 'province', 'p', 'postalCode', '0000',
    'employmentStatus', 'e', 'maritalStatus', 'm', 'consentUA', 'ua', 'consentsPresented', jsonb_build_array('x'),
    'consentAccepted', true);
  r   jsonb;
  rec record;
  sec record;
  n   int;
begin
  if c1 is null or c2 is null then raise exception 'T17 FAIL: the fixture consultants have no link code'; end if;

  -- 1. A valid application through an active link is consent_confirmed at once, with the identity-check
  --    token minted: 64 hex characters back to the caller, only the sha256 stored, 30-minute expiry.
  r := submit_application(p, c1);
  select * into rec from credit_checks where ref = r->>'ref';
  if rec.status <> 'consent_confirmed' or rec.consent_confirmed_at is null or rec.mm_person_id <> '9302170340096' then
    raise exception 'T17 FAIL: the new record is wrong: % %', rec.status, rec.consent_confirmed_at;
  end if;
  if (r->>'idv_token') !~ '^[0-9a-f]{64}$' then raise exception 'T17 FAIL: no token: %', r; end if;
  select * into sec from credit_check_secrets where ref = r->>'ref';
  if sec.idv_token_hash <> encode(digest(r->>'idv_token', 'sha256'), 'hex') then
    raise exception 'T17 FAIL: the stored hash is not the token''s sha256';
  end if;
  if sec.idv_token_expires < now() + interval '29 minutes' or sec.idv_token_expires > now() + interval '31 minutes' then
    raise exception 'T17 FAIL: token expiry %', sec.idv_token_expires;
  end if;
  if (rec.audit -> 0 ->> 'event') <> 'Form submitted by client' or (rec.audit -> 1 ->> 'event') not like 'Consent declaration accepted on the form%' then
    raise exception 'T17 FAIL: audit %', rec.audit;
  end if;
  -- (mm-client attaches the consultant straight after; the test does it the same way so the caps below count it.)
  perform attach_consultant(r->>'ref', c1);

  -- 2. Refused, nothing written: no consent flag; no / inactive / made-up link; a crafted payload.
  begin
    perform submit_application(p - 'consentAccepted', c1);
    raise exception 'accepted an application without the consent flag';
  exception when others then
    if sqlerrm <> 'consent_required' then raise exception 'T17 FAIL (consent): %', sqlerrm; end if;
  end;
  begin
    perform submit_application(p || '{"consentAccepted": "yes"}', c1);
    raise exception 'accepted a consent flag that is not true';
  exception when others then
    if sqlerrm <> 'consent_required' then raise exception 'T17 FAIL (consent 2): %', sqlerrm; end if;
  end;
  begin
    perform submit_application(p, 'nosuch22');
    raise exception 'accepted a made-up link';
  exception when others then
    if sqlerrm <> 'consultant_link_required' then raise exception 'T17 FAIL (link): %', sqlerrm; end if;
  end;
  begin
    perform submit_application(p, null);
    raise exception 'accepted no link';
  exception when others then
    if sqlerrm <> 'consultant_link_required' then raise exception 'T17 FAIL (null link): %', sqlerrm; end if;
  end;
  begin
    perform submit_application(p || '{"idNumber": "1234567890123"}', c1);
    raise exception 'accepted an invalid ID number';
  exception when others then
    if sqlerrm <> 'invalid_id_number' then raise exception 'T17 FAIL (id): %', sqlerrm; end if;
  end;
  begin
    perform submit_application(p || '{"cell": "12345"}', c1);
    raise exception 'accepted an invalid cellphone';
  exception when others then
    if sqlerrm <> 'invalid_cell' then raise exception 'T17 FAIL (cell): %', sqlerrm; end if;
  end;
  begin
    perform submit_application(p || '{"idType": "other"}', c1);
    raise exception 'accepted an unknown ID type';
  exception when others then
    if sqlerrm <> 'invalid_id_type' then raise exception 'T17 FAIL (type): %', sqlerrm; end if;
  end;
  select count(*) into n from credit_checks where mm_person_id = '9302170340096';
  if n <> 1 then raise exception 'T17 FAIL: a refused application left a record (% rows)', n; end if;

  -- 3. At most 5 per person AND link per 24 hours (one exists already)...
  for n in 1..4 loop
    r := submit_application(p, c1); perform attach_consultant(r->>'ref', c1);
  end loop;
  begin
    perform submit_application(p, c1);
    raise exception 'accepted a sixth application for the person through the same link';
  exception when others then
    if sqlerrm <> 'too_many_submissions' then raise exception 'T17 FAIL (person cap): %', sqlerrm; end if;
  end;
  -- ...but the same person through ANOTHER consultant's link is not locked out, and a different
  --    person on the same cellphone is fine (no phone rule).
  r := submit_application(p, c2); perform attach_consultant(r->>'ref', c2);
  r := submit_application(p || '{"idNumber": "8001015000086"}', c1); perform attach_consultant(r->>'ref', c1);

  -- 4. Per link per 24 hours (link c1 now has 6 records): a cap of 6 refuses the next one, while
  --    link c2 (1 record) is not affected.
  begin
    perform submit_application(p || '{"idNumber": "8001015000086"}', c1, 6);
    raise exception 'accepted an application past the per-link cap';
  exception when others then
    if sqlerrm <> 'too_many_applications' then raise exception 'T17 FAIL (link cap): %', sqlerrm; end if;
  end;
  r := submit_application(p || '{"idNumber": "8001015000086"}', c2, 6); perform attach_consultant(r->>'ref', c2);

  -- 5. The circuit breaker: 8 records exist in the last 24 hours, so a daily cap of 8 refuses the next.
  begin
    perform submit_application(p || '{"idNumber": "8001015000086"}', c2, 30, 8);
    raise exception 'accepted an application past the daily cap';
  exception when others then
    if sqlerrm <> 'too_many_applications' then raise exception 'T17 FAIL (daily cap): %', sqlerrm; end if;
  end;

  -- 6. Nothing else can call it; the one-phone constraint is gone; the clean-up still runs.
  if has_function_privilege('anon', 'public.submit_application(jsonb, text, int, int)', 'execute')
     or has_function_privilege('authenticated', 'public.submit_application(jsonb, text, int, int)', 'execute')
     or not has_function_privilege('service_role', 'public.submit_application(jsonb, text, int, int)', 'execute') then
    raise exception 'T17 FAIL: submit_application is not server-only';
  end if;
  if (select count(*) from pg_proc where proname = 'submit_application') <> 1 then
    raise exception 'T17 FAIL: more than one submit_application';
  end if;
  if exists (select 1 from pg_constraint where conname = 'one_person_per_cellphone') then
    raise exception 'T17 FAIL: the one-phone constraint still exists';
  end if;
  perform expire_stale_records();

  raise notice 'T17 ok: an application is consent_confirmed at once with its token; consent flag + active link required; 5 per person+link, per-link and daily caps; server-only';
end $$;

rollback;
