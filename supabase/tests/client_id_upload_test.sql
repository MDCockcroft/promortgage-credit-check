-- Tests for 20261009_client_id_upload.sql. Run by run-local.sh after every migration. Rolled back.
begin;
insert into credit_checks (ref, status, first_names, surname, id_type, email, cell, street, suburb, city,
    province, postal_code, employment_status, marital_status, consent_registered_at)
  values ('PM-CL1', 'consent_registered', 'T', 'T', 'said', 't@x', '0820000021', 's', 's', 'c', 'p', '0000', 'e', 'm', now()),
         ('PM-CL2', 'consent_registered', 'T', 'T', 'said', 't@x', '0820000022', 's', 's', 'c', 'p', '0000', 'e', 'm', now());
do $$
declare
  u constant uuid := '00000000-0000-0000-0000-0000000000c4';
  prev text[]; r record;
begin
  -- 1. The client's upload: front and back, audited, source 'client', no uploader.
  perform attach_id_copy_client('PM-CL1', 'PM-CL1/idcopy-b.jpg', 'image/jpeg', 110, 'bbb', 'PM-CL1/idback-c.jpg', 'image/jpeg', 120, 'ccc');
  select * into r from credit_checks where ref = 'PM-CL1';
  if r.id_document_path <> 'PM-CL1/idcopy-b.jpg' or r.id_document_source <> 'client' or r.id_document_uploaded_by is not null
     or r.id_document_uploaded_at is null or r.id_document_back_path <> 'PM-CL1/idback-c.jpg' or r.id_document_back_sha256 <> 'ccc'
     or (r.audit -> -1 ->> 'event') <> 'Client''s ID copy attached by the client on the online form (front and back)' then
    raise exception 'T20 FAIL: client attach did not record the copy: %', row_to_json(r);
  end if;
  -- One attach per application: the client cannot change what is on the record (a replay writes nothing).
  begin
    perform attach_id_copy_client('PM-CL1', 'PM-CL1/idcopy-d.jpg', 'image/jpeg', 10, 'ddd', null, null, null, null);
    raise exception 'the client replaced their copy';
  exception when others then
    if sqlerrm <> 'id_copy_present' then raise exception 'T20 FAIL (present): %', sqlerrm; end if;
  end;
  select * into r from credit_checks where ref = 'PM-CL1';
  if r.id_document_path <> 'PM-CL1/idcopy-b.jpg' or jsonb_array_length(r.audit) <> 1 then
    raise exception 'T20 FAIL: a refused client attach changed the record: %', row_to_json(r);
  end if;

  -- 2. Details missing, or a path that is not this record's own front / back object, are refused.
  begin
    perform attach_id_copy_client('PM-CL2', 'PM-CL2/idcopy-d.jpg', 'image/jpeg', 10, 'ddd', 'PM-CL2/idback-e.jpg', null, null, null);
    raise exception 'accepted a back without its type';
  exception when others then
    if sqlerrm <> 'id_copy_invalid' then raise exception 'T20 FAIL (back invalid): %', sqlerrm; end if;
  end;
  begin
    perform attach_id_copy_client('PM-CL2', null, null, null, null, null, null, null, null);
    raise exception 'accepted an empty front';
  exception when others then
    if sqlerrm <> 'id_copy_invalid' then raise exception 'T20 FAIL (front invalid): %', sqlerrm; end if;
  end;
  begin
    perform attach_id_copy_client('PM-CL2', 'PM-CL1/idcopy-d.jpg', 'image/jpeg', 10, 'ddd', null, null, null, null);
    raise exception 'accepted another record''s front';
  exception when others then
    if sqlerrm <> 'id_copy_invalid' then raise exception 'T20 FAIL (foreign front): %', sqlerrm; end if;
  end;
  begin
    perform attach_id_copy_client('PM-CL2', 'PM-CL2/idcopy-d.jpg', 'image/jpeg', 10, 'ddd', 'PM-CL2/idcopy-d.jpg', 'image/jpeg', 10, 'ddd');
    raise exception 'accepted a front object as the back';
  exception when others then
    if sqlerrm <> 'id_copy_invalid' then raise exception 'T20 FAIL (front as back): %', sqlerrm; end if;
  end;
  begin
    perform attach_id_copy('PM-CL2', u, 'tester', 'PM-CL1/idcopy-z.pdf', 'application/pdf', 10, 'zzz');
    raise exception 'staff attach accepted another record''s object';
  exception when others then
    if sqlerrm <> 'id_copy_invalid' then raise exception 'T20 FAIL (staff foreign path): %', sqlerrm; end if;
  end;
  if (select id_document_path from credit_checks where ref = 'PM-CL2') is not null then
    raise exception 'T20 FAIL: a refused attach wrote to PM-CL2';
  end if;

  -- 3. The gate (20261008) accepts the client's copy. Mid-check, and after a check, a manual verification
  --    or a withdrawal, the client's window is closed whatever is on the record (busy / locked come first).
  update credit_checks set status = 'idv_passed' where ref = 'PM-CL1';
  update credit_checks set status = 'check_in_flight' where ref = 'PM-CL1';
  begin
    update credit_checks set status = 'check_in_flight' where ref = 'PM-CL2';
    raise exception 'claimed a check without an ID copy';
  exception when others then
    if sqlerrm <> 'id_copy_required' then raise exception 'T20 FAIL (gate): %', sqlerrm; end if;
  end;
  begin
    perform attach_id_copy_client('PM-CL1', 'PM-CL1/idcopy-f.jpg', 'image/jpeg', 10, 'fff', null, null, null, null);
    raise exception 'attached mid-check';
  exception when others then
    if sqlerrm <> 'id_copy_busy' then raise exception 'T20 FAIL (busy): %', sqlerrm; end if;
  end;
  update credit_checks set status = 'report_ready' where ref = 'PM-CL1';
  begin
    perform attach_id_copy_client('PM-CL1', 'PM-CL1/idcopy-g.jpg', 'image/jpeg', 10, 'ggg', null, null, null, null);
    raise exception 'attached after the check';
  exception when others then
    if sqlerrm <> 'id_copy_locked' then raise exception 'T20 FAIL (locked): %', sqlerrm; end if;
  end;
  update credit_checks set status = 'manual_verified' where ref = 'PM-CL2';
  begin
    perform attach_id_copy_client('PM-CL2', 'PM-CL2/idcopy-g.jpg', 'image/jpeg', 10, 'ggg', null, null, null, null);
    raise exception 'attached after a manual verification';
  exception when others then
    if sqlerrm <> 'id_copy_locked' then raise exception 'T20 FAIL (locked, manual): %', sqlerrm; end if;
  end;
  update credit_checks set status = 'consent_registered' where ref = 'PM-CL2';

  -- 4. The consultant's replacement drops the back too and returns both paths; the client is then shut
  --    out by the same one-attach rule.
  update credit_checks set status = 'idv_passed' where ref = 'PM-CL1';
  prev := attach_id_copy('PM-CL1', u, 'tester', 'PM-CL1/idcopy-h.pdf', 'application/pdf', 300, 'hhh');
  if prev <> array['PM-CL1/idcopy-b.jpg', 'PM-CL1/idback-c.jpg'] then raise exception 'T20 FAIL: staff replace returned %', prev; end if;
  select * into r from credit_checks where ref = 'PM-CL1';
  if r.id_document_source <> 'staff' or r.id_document_uploaded_by <> u or r.id_document_back_path is not null
     or r.id_document_back_sha256 is not null then
    raise exception 'T20 FAIL: staff replace left the back: %', row_to_json(r);
  end if;
  begin
    perform attach_id_copy_client('PM-CL1', 'PM-CL1/idcopy-i.jpg', 'image/jpeg', 10, 'iii', null, null, null, null);
    raise exception 'the client overwrote a consultant''s copy';
  exception when others then
    if sqlerrm <> 'id_copy_present' then raise exception 'T20 FAIL (over staff): %', sqlerrm; end if;
  end;

  -- 5. A fresh record: the staff attach with nothing there returns an empty array (not null); the access
  --    log accepts the new action.
  prev := attach_id_copy('PM-CL2', u, 'tester', 'PM-CL2/idcopy-a.pdf', 'application/pdf', 300, 'aaa');
  if prev is null or prev <> '{}'::text[] then raise exception 'T20 FAIL: first staff attach returned %', prev; end if;
  insert into report_access_log (ref, user_id, action) values ('PM-CL2', u, 'view_id_document_back');

  -- 6. Server-only, like attach_id_copy.
  if has_function_privilege('anon', 'public.attach_id_copy_client(text, text, text, int, text, text, text, int, text)', 'execute')
     or has_function_privilege('authenticated', 'public.attach_id_copy_client(text, text, text, int, text, text, text, int, text)', 'execute') then
    raise exception 'T20 FAIL: attach_id_copy_client is callable by a client role';
  end if;
  raise notice 'T20 ok: the client''s ID upload (front + back) once per application, only while it is their turn, paths bound to the record; staff replace clears the back';
end $$;
rollback;
