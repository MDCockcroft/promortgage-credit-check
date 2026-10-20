-- Tests for 20261008_id_copy_required.sql. Run by run-local.sh after every migration. Rolled back.
begin;
insert into credit_checks (ref, status, first_names, surname, id_type, email, cell, street, suburb, city,
    province, postal_code, employment_status, marital_status, consent_registered_at, idv_passed_at)
  values ('PM-ID1', 'idv_passed', 'T', 'T', 'said', 't@x', '0820000011', 's', 's', 'c', 'p', '0000', 'e', 'm', now(), now());
do $$
declare
  u constant uuid := '00000000-0000-0000-0000-0000000000c3';
  prev text; n int; r record;
begin
  -- 1. No credit check without the ID copy: the database refuses the claim itself.
  begin
    update credit_checks set status = 'check_in_flight' where ref = 'PM-ID1';
    raise exception 'claimed a credit check without an ID copy';
  exception when others then
    if sqlerrm <> 'id_copy_required' then raise exception 'T19 FAIL (gate): %', sqlerrm; end if;
  end;
  if (select status from credit_checks where ref = 'PM-ID1') <> 'idv_passed' then raise exception 'T19 FAIL: status changed'; end if;

  -- 2. Attach: first time returns null (nothing to delete) and audits; a replace returns the previous path.
  prev := attach_id_copy('PM-ID1', u, 'tester', 'PM-ID1/idcopy-a.pdf', 'application/pdf', 100, 'aaa');
  if prev is not null then raise exception 'T19 FAIL: first attach returned %', prev; end if;
  select * into r from credit_checks where ref = 'PM-ID1';
  if r.id_document_path <> 'PM-ID1/idcopy-a.pdf' or r.id_document_uploaded_by <> u or r.id_document_uploaded_at is null
     or (r.audit -> -1 ->> 'event') not like 'Client''s ID copy attached by tester%' then
    raise exception 'T19 FAIL: attach did not record the copy: %', row_to_json(r);
  end if;
  prev := attach_id_copy('PM-ID1', u, 'tester', 'PM-ID1/idcopy-b.jpg', 'image/jpeg', 200, 'bbb');
  if prev <> 'PM-ID1/idcopy-a.pdf' then raise exception 'T19 FAIL: replace returned %', prev; end if;
  if (select audit -> -1 ->> 'event' from credit_checks where ref = 'PM-ID1') not like 'Client''s ID copy replaced by%' then
    raise exception 'T19 FAIL: replace not audited';
  end if;
  begin
    perform attach_id_copy('PM-ID1', u, 'tester', 'PM-ID1/idcopy-c.gif', 'image/gif', 10, 'ccc');
    raise exception 'accepted a gif';
  exception when check_violation then null;
  end;

  -- 3. With the copy on the record the claim goes through; while in flight the copy cannot be swapped.
  update credit_checks set status = 'check_in_flight' where ref = 'PM-ID1';
  begin
    perform attach_id_copy('PM-ID1', u, 'tester', 'PM-ID1/idcopy-d.pdf', 'application/pdf', 10, 'ddd');
    raise exception 'swapped the ID copy mid-check';
  exception when others then
    if sqlerrm <> 'id_copy_busy' then raise exception 'T19 FAIL (busy): %', sqlerrm; end if;
  end;
  update credit_checks set status = 'idv_failed' where ref = 'PM-ID1';

  -- 4. Manual verification: refused without the form, without the confirmation, and without an ID copy on the record.
  update credit_checks set id_document_path = null where ref = 'PM-ID1';
  begin
    perform record_manual_verification('PM-ID1', 'idv_failed', u, 'tester', 'v1', 'statement',
      'f1', 'PM-ID1/consent-x.pdf', 'application/pdf', 20, 'xxx', 'c1', 'I confirm');
    raise exception 'verified without an ID copy on the record';
  exception when others then
    if sqlerrm <> 'id_copy_required' then raise exception 'T19 FAIL (no id copy): %', sqlerrm; end if;
  end;
  update credit_checks set id_document_path = 'PM-ID1/idcopy-b.jpg' where ref = 'PM-ID1';
  begin
    perform record_manual_verification('PM-ID1', 'idv_failed', u, 'tester', 'v1', 'statement',
      'f1', 'PM-ID1/consent-x.pdf', 'application/pdf', 20, 'xxx', null, null);
    raise exception 'verified without the confirmation';
  exception when others then
    if sqlerrm <> 'confirmation_required' then raise exception 'T19 FAIL (no confirmation): %', sqlerrm; end if;
  end;
  select count(*) into n from manual_verifications where ref = 'PM-ID1';
  if n <> 0 then raise exception 'T19 FAIL: a refused verification left evidence'; end if;

  -- 5. The complete override: evidence holds the form and both statements, no photo columns; status moves.
  n := record_manual_verification('PM-ID1', 'idv_failed', u, 'tester', 'v1', 'statement',
    'f1', 'PM-ID1/consent-x.pdf', 'application/pdf', 20, 'xxx', 'c1', 'I confirm');
  select * into r from manual_verifications where id = n;
  if r.confirmation_version <> 'c1' or r.confirmation_text <> 'I confirm' or r.confirmation_sha256 <> encode(digest('I confirm', 'sha256'), 'hex')
     or r.document_path is not null or r.consent_form_sha256 <> 'xxx' then
    raise exception 'T19 FAIL: evidence row wrong: %', row_to_json(r);
  end if;
  select status, audit into r from credit_checks where ref = 'PM-ID1';
  if r.status <> 'manual_verified' or (r.audit -> -1 ->> 'event') not like '%identity confirmation; ID copy on record%' then
    raise exception 'T19 FAIL: record not moved: %', row_to_json(r);
  end if;

  -- 6. One function, 13 arguments, server-only; the gate trigger exists; attach is server-only.
  select count(*) into n from pg_proc where proname = 'record_manual_verification';
  if n <> 1 or (select pronargs from pg_proc where proname = 'record_manual_verification') <> 13 then
    raise exception 'T19 FAIL: expected one 13-argument record_manual_verification';
  end if;
  if has_function_privilege('anon', 'public.attach_id_copy(text, uuid, text, text, text, int, text)', 'execute')
     or has_function_privilege('authenticated', 'public.attach_id_copy(text, uuid, text, text, text, int, text)', 'execute') then
    raise exception 'T19 FAIL: attach_id_copy is not server-only';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'credit_checks_require_id_copy') then
    raise exception 'T19 FAIL: the gate trigger is missing';
  end if;
  raise notice 'T19 ok: no check without the ID copy (database gate); attach/replace audited; override = form + both statements + ID copy on record';
end $$;
rollback;
