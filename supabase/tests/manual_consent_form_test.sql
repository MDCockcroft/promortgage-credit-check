-- Tests for 20261002_manual_consent_form.sql. Run by run-local.sh after every migration.
-- Everything here is rolled back, so no record is left behind for the other test files.
begin;

insert into credit_checks (ref, status, first_names, surname, id_type, email, cell, street, suburb, city,
    province, postal_code, employment_status, marital_status, consent_registered_at)
  values ('PM-MF1', 'idv_failed', 'T', 'T', 'said', 't@x', '0820000000', 's', 's', 'c', 'p', '0000', 'e', 'm', now());

do $$
declare
  u constant uuid := '00000000-0000-0000-0000-0000000000c1';
  v bigint;
  n int;
  r record;
begin
  -- 1. A caller from before this migration sends no signed consent form: refused, nothing written.
  begin
    v := record_manual_verification('PM-MF1', 'idv_failed', u, 'tester', 'v1', 'statement',
      'PM-MF1/a.pdf', 'application/pdf', 10, 'aaa');
    raise exception 'saved without a signed consent form';
  exception when others then
    if sqlerrm <> 'consent_form_required' then raise exception 'T14 FAIL (no form): %', sqlerrm; end if;
  end;

  -- 2. The signed form and the ID copy must be different files.
  begin
    v := record_manual_verification('PM-MF1', 'idv_failed', u, 'tester', 'v1', 'statement',
      'PM-MF1/a.pdf', 'application/pdf', 10, 'aaa',
      'f1', 'PM-MF1/consent-b.pdf', 'application/pdf', 20, 'aaa');
    raise exception 'accepted the same file as both documents';
  exception when others then
    if sqlerrm <> 'consent_form_same_as_id_copy' then raise exception 'T14 FAIL (same file): %', sqlerrm; end if;
  end;

  select count(*) into n from manual_verifications where ref = 'PM-MF1';
  if n <> 0 or (select status from credit_checks where ref = 'PM-MF1') <> 'idv_failed' then
    raise exception 'T14 FAIL: a refused verification left something behind (% rows)', n;
  end if;

  -- 3. With both files: evidence and status change together, and the form is on the evidence row.
  v := record_manual_verification('PM-MF1', 'idv_failed', u, 'tester', 'v1', 'statement',
    'PM-MF1/a.pdf', 'application/pdf', 10, 'aaa',
    'f1', 'PM-MF1/consent-b.pdf', 'image/png', 20, 'bbb');
  if v is null then raise exception 'T14 FAIL: a complete verification was not saved'; end if;
  select * into r from manual_verifications where id = v;
  if r.consent_form_version <> 'f1' or r.consent_form_path <> 'PM-MF1/consent-b.pdf' or r.consent_form_type <> 'image/png'
     or r.consent_form_bytes <> 20 or r.consent_form_sha256 <> 'bbb' or r.document_sha256 <> 'aaa' then
    raise exception 'T14 FAIL: the evidence row is wrong: %', row_to_json(r);
  end if;
  select status, manual_verification_id, audit into r from credit_checks where ref = 'PM-MF1';
  if r.status <> 'manual_verified' or r.manual_verification_id <> v
     or (r.audit -> -1 ->> 'event') not like '%signed consent form + ID copy uploaded%' then
    raise exception 'T14 FAIL: the record was not updated with the evidence: %', row_to_json(r);
  end if;

  -- 4. A record that has moved on writes nothing (the same call again: no longer idv_failed).
  v := record_manual_verification('PM-MF1', 'idv_failed', u, 'tester', 'v1', 'statement',
    'PM-MF1/a.pdf', 'application/pdf', 10, 'aaa',
    'f1', 'PM-MF1/consent-c.pdf', 'image/png', 20, 'ccc');
  if v is not null or (select count(*) from manual_verifications where ref = 'PM-MF1') <> 1 then
    raise exception 'T14 FAIL: a record that had moved on was verified again';
  end if;

  -- 5. Exactly one function by this name (the pre-migration one is gone), and it is server-only.
  select count(*) into n from pg_proc where proname = 'record_manual_verification';
  if n <> 1 or (select pronargs from pg_proc where proname = 'record_manual_verification') <> 15 then
    raise exception 'T14 FAIL: expected one 15-argument record_manual_verification, found %', n;
  end if;
  if has_function_privilege('anon', (select oid from pg_proc where proname = 'record_manual_verification'), 'execute')
     or has_function_privilege('authenticated', (select oid from pg_proc where proname = 'record_manual_verification'), 'execute')
     or not has_function_privilege('service_role', (select oid from pg_proc where proname = 'record_manual_verification'), 'execute') then
    raise exception 'T14 FAIL: record_manual_verification is not server-only';
  end if;

  -- 6. Opening a stored signed form can be logged.
  if (select pg_get_constraintdef(oid) from pg_constraint where conname = 'report_access_log_action_check')
     not like '%view_signed_consent_form%' then
    raise exception 'T14 FAIL: the access log does not accept view_signed_consent_form';
  end if;

  raise notice 'T14 ok: no manual verification without the signed consent form; both files saved as evidence; server-only';
end $$;

rollback;
