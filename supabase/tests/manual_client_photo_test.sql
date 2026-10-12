-- Tests for 20261004_manual_client_photo.sql. Run by run-local.sh after every migration.
-- Everything here is rolled back, so no record is left behind for the other test files.
begin;

insert into credit_checks (ref, status, first_names, surname, id_type, email, cell, street, suburb, city,
    province, postal_code, employment_status, marital_status, consent_registered_at)
  values ('PM-MP1', 'idv_failed', 'T', 'T', 'said', 't@x', '0820000001', 's', 's', 'c', 'p', '0000', 'e', 'm', now());

do $$
declare
  u constant uuid := '00000000-0000-0000-0000-0000000000c2';
  v bigint;
  n int;
  r record;
begin
  -- 1. A caller from before this migration (the ID copy + the signed form, no kind): refused.
  begin
    v := record_manual_verification('PM-MP1', 'idv_failed', u, 'tester', 'v1', 'statement',
      'PM-MP1/a.pdf', 'application/pdf', 10, 'aaa',
      'f1', 'PM-MP1/consent-b.pdf', 'application/pdf', 20, 'bbb');
    raise exception 'saved an ID copy as the evidence';
  exception when others then
    if sqlerrm <> 'client_photo_required' then raise exception 'T16 FAIL (old caller): %', sqlerrm; end if;
  end;

  -- 2. The right kind, but a PDF: a PDF is never a photo. (Also a null type, which "not in" alone would let through.)
  begin
    v := record_manual_verification('PM-MP1', 'idv_failed', u, 'tester', 'v1', 'statement',
      'PM-MP1/photo-a.pdf', 'application/pdf', 10, 'aaa',
      'f1', 'PM-MP1/consent-b.pdf', 'application/pdf', 20, 'bbb', 'client_photo');
    raise exception 'saved a PDF as the photo';
  exception when others then
    if sqlerrm <> 'client_photo_must_be_image' then raise exception 'T16 FAIL (pdf photo): %', sqlerrm; end if;
  end;
  begin
    v := record_manual_verification('PM-MP1', 'idv_failed', u, 'tester', 'v1', 'statement',
      'PM-MP1/photo-a.jpg', null, 10, 'aaa',
      'f1', 'PM-MP1/consent-b.pdf', 'application/pdf', 20, 'bbb', 'client_photo');
    raise exception 'saved a photo with no type';
  exception when others then
    if sqlerrm <> 'client_photo_must_be_image' then raise exception 'T16 FAIL (null type): %', sqlerrm; end if;
  end;

  select count(*) into n from manual_verifications where ref = 'PM-MP1';
  if n <> 0 or (select status from credit_checks where ref = 'PM-MP1') <> 'idv_failed' then
    raise exception 'T16 FAIL: a refused verification left something behind (% rows)', n;
  end if;

  -- 3. A JPG or PNG photo with the signed form: saved, and the row says what the file is.
  v := record_manual_verification('PM-MP1', 'idv_failed', u, 'tester', 'v1', 'statement',
    'PM-MP1/photo-a.png', 'image/png', 10, 'aaa',
    'f1', 'PM-MP1/consent-b.jpg', 'image/jpeg', 20, 'bbb', 'client_photo');
  if v is null then raise exception 'T16 FAIL: a complete verification was not saved'; end if;
  select * into r from manual_verifications where id = v;
  if r.document_kind <> 'client_photo' or r.document_path <> 'PM-MP1/photo-a.png' or r.document_type <> 'image/png' then
    raise exception 'T16 FAIL: the evidence row is wrong: %', row_to_json(r);
  end if;
  if (select status from credit_checks where ref = 'PM-MP1') <> 'manual_verified' then
    raise exception 'T16 FAIL: the record did not become manual_verified';
  end if;

  -- 4. The kind has no default: nothing can write a row without saying what its file is, and
  --    the rows from before this file are labelled ID copies.
  if (select column_default from information_schema.columns
       where table_schema = 'public' and table_name = 'manual_verifications' and column_name = 'document_kind') is not null then
    raise exception 'T16 FAIL: document_kind still has a default';
  end if;
  begin
    insert into manual_verifications (ref, verified_by, verified_by_label, attestation_version, attestation_text,
      attestation_sha256, document_path, document_type, document_bytes, document_sha256)
    values ('PM-MP1', u, 'tester', 'v1', 's', 'h', 'PM-MP1/x.jpg', 'image/jpeg', 1, 'x');
    raise exception 'a row without a kind was accepted';
  exception when not_null_violation then null;
  end;
  begin
    insert into manual_verifications (ref, verified_by, verified_by_label, attestation_version, attestation_text,
      attestation_sha256, document_kind, document_path, document_type, document_bytes, document_sha256)
    values ('PM-MP1', u, 'tester', 'v1', 's', 'h', 'selfie', 'PM-MP1/x.jpg', 'image/jpeg', 1, 'x');
    raise exception 'an unknown kind was accepted';
  exception when check_violation then null;
  end;

  -- 5. Opening a stored photo, and downloading the completed form, can be logged.
  if (select pg_get_constraintdef(oid) from pg_constraint where conname = 'report_access_log_action_check')
     not like '%view_client_photo%' then
    raise exception 'T16 FAIL: the access log does not accept view_client_photo';
  end if;
  if (select pg_get_constraintdef(oid) from pg_constraint where conname = 'report_access_log_action_check')
     not like '%download_form%' then
    raise exception 'T16 FAIL: the access log does not accept download_form';
  end if;

  raise notice 'T16 ok: the photo of the client (an image) and the signed form are required; an ID copy or a PDF is refused; the kind is recorded';
end $$;

rollback;
