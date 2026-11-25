-- Tests for 20261012_home_loan_page1.sql. Run by run-local.sh after every migration. Rolled back.
begin;
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000e1', 'page1@test');
select upsert_staff_member('00000000-0000-0000-0000-0000000000e1', 'consultant', true, '00000000-0000-0000-0000-00000000000a');
do $$
declare
  c text := (select link_code from staff_members where user_id = '00000000-0000-0000-0000-0000000000e1');
  base jsonb := jsonb_build_object(
    'idType', 'said', 'idNumber', '9302170340096', 'firstNames', 'T', 'surname', 'T', 'email', 't@x',
    'cell', '0821234567', 'street', 's', 'suburb', 's', 'city', 'c', 'province', 'p', 'postalCode', '0000',
    'employmentStatus', 'Full-time Employee', 'maritalStatus', 'Married ANC', 'consentUA', 'ua',
    'consentsPresented', jsonb_build_array('x'), 'consentAccepted', true);
  r jsonb; rec record; d jsonb;
begin
  -- 1. The page-1 answers are stored; the answers with their own columns stay there; no income is needed.
  r := submit_application(base || jsonb_build_object('details', jsonb_build_object(
    'gender', 'Female', 'ethnicGroup', 'African', 'homeLanguage', '  isiZulu  ', 'employerName', 'Example Holdings',
    'sarsTaxNumber', '', 'foreignTaxNumber', '   ',
    'hack', 'not a form field', 'nested', jsonb_build_object('a', 1), 'number', 5,
    'occupation', repeat('x', 500))), c);
  select * into rec from credit_checks where ref = r->>'ref';
  d := rec.application_details;
  if d ->> 'gender' <> 'Female' or d ->> 'ethnicGroup' <> 'African' or d ->> 'homeLanguage' <> 'isiZulu'
     or d ->> 'employerName' <> 'Example Holdings' then
    raise exception 'T32 FAIL: details not stored as sent: %', d;
  end if;
  if d ? 'hack' or d ? 'nested' or d ? 'number' or d ? 'sarsTaxNumber' or d ? 'foreignTaxNumber' then
    raise exception 'T32 FAIL: unknown, non-text or empty answers were stored: %', d;
  end if;
  if length(d ->> 'occupation') <> 200 then raise exception 'T32 FAIL: a long answer was not cut to 200: %', length(d ->> 'occupation'); end if;
  if rec.marital_status <> 'Married ANC' or rec.employment_status <> 'Full-time Employee' or rec.gross_income is not null then
    raise exception 'T32 FAIL: the record''s own columns are wrong: %, %, %', rec.marital_status, rec.employment_status, rec.gross_income;
  end if;

  -- 2. A form page cached from before this change sends no details: accepted, nothing stored.
  r := submit_application(base || jsonb_build_object('idNumber', '8001015009087', 'grossIncome', '41500'), c);
  select * into rec from credit_checks where ref = r->>'ref';
  if rec.application_details is not null or rec.gross_income <> 41500 then
    raise exception 'T32 FAIL: an old-form application changed: %, %', rec.application_details, rec.gross_income;
  end if;

  -- 3. Details that are not an object store nothing (and never stop the application).
  if clean_application_details('"text"'::jsonb) is not null or clean_application_details('[1,2]'::jsonb) is not null
     or clean_application_details(null) is not null or clean_application_details('{}'::jsonb) is not null then
    raise exception 'T32 FAIL: non-object details were kept';
  end if;

  -- 4. Server-only.
  if has_function_privilege('anon', 'public.clean_application_details(jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public.clean_application_details(jsonb)', 'execute')
     or has_function_privilege('anon', 'public.submit_application(jsonb, text, int, int)', 'execute') then
    raise exception 'T32 FAIL: reachable from the browser';
  end if;
  raise notice 'T32 ok: page-1 answers stored clean (known keys, text, 200 max); old form still accepted; server-only';
end $$;
rollback;
