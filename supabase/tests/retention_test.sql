-- Tests for 20261010_retention.sql. Run by run-local.sh after every migration. Rolled back.
begin;
insert into credit_checks (ref, status, first_names, surname, id_type, email, cell, street, suburb, city,
    province, postal_code, employment_status, marital_status, consent_registered_at, report_ready_at, group_id,
    bureau_enquiry_id, report_json, report_summary, affordability_json, report_pdf_path, pdf_status)
  values
  ('PM-RP1', 'report_ready', 'T', 'T', 'said', 't@x', '0820000031', 's', 's', 'c', 'p', '0000', 'e', 'm', now(),
     now() - interval '13 months', 'G1', 'ENQ-1', '{"big": "report"}', '{"score": 642, "riskType": "Medium", "rag": "Amber", "enquiryId": "ENQ-1", "flags": {"fraud": "no"}}',
     '{"amount": 1}', 'PM-RP1/report.pdf', 'stored'),
  ('PM-RP2', 'report_ready', 'T', 'T', 'said', 't@x', '0820000032', 's', 's', 'c', 'p', '0000', 'e', 'm', now(),
     now() - interval '11 months', 'G2', 'ENQ-2', '{"big": "report"}', '{"score": 700}', null, 'PM-RP2/report.pdf', 'stored');
insert into credit_checks (ref, status, first_names, surname, id_type, email, cell, street, suburb, city,
    province, postal_code, employment_status, marital_status, consent_confirmed_at, created_at)
  values ('PM-EX1', 'consent_confirmed', 'T', 'T', 'said', 't@x', '0820000033', 's', 's', 'c', 'p', '0000', 'e', 'm',
          now() - interval '8 days', now() - interval '8 days'),
         ('PM-EX2', 'expired', 'T', 'T', 'said', 't@x', '0820000034', 's', 's', 'c', 'p', '0000', 'e', 'm',
          now() - interval '60 days', now() - interval '60 days');
do $$
declare p text; r record; n int;
begin
  -- 1. A report older than 12 months is purged: data and PDF reference gone, the band and reference kept, audited.
  p := purge_report('PM-RP1');
  if p <> 'PM-RP1/report.pdf' then raise exception 'T21 FAIL: purge returned %', p; end if;
  select * into r from credit_checks where ref = 'PM-RP1';
  if r.report_json is not null or r.affordability_json is not null or r.report_pdf_path is not null or r.pdf_status is not null
     or r.report_purged_at is null or r.status <> 'report_ready' or r.report_ready_at is null or r.bureau_enquiry_id <> 'ENQ-1' then
    raise exception 'T21 FAIL: purge left data or lost the kept fields: %', row_to_json(r);
  end if;
  if r.report_summary ->> 'riskType' <> 'Medium' or r.report_summary ->> 'rag' <> 'Amber' or r.report_summary ->> 'enquiryId' <> 'ENQ-1'
     or (r.report_summary ->> 'purged')::boolean is not true or r.report_summary ? 'score' or r.report_summary ? 'flags' then
    raise exception 'T21 FAIL: reduced summary wrong: %', r.report_summary;
  end if;
  if (r.audit -> -1 ->> 'event') not like 'Credit report deleted 12 months after receipt%' then raise exception 'T21 FAIL: not audited'; end if;
  -- Once only.
  if purge_report('PM-RP1') is not null then raise exception 'T21 FAIL: purged twice'; end if;
  -- 2. A report younger than 12 months is untouched.
  if purge_report('PM-RP2') is not null then raise exception 'T21 FAIL: purged a young report'; end if;
  if (select report_json from credit_checks where ref = 'PM-RP2') is null then raise exception 'T21 FAIL: young report lost'; end if;

  -- 3. The clean-up stamps expired_at; the backfill stamped the old row at its 7-day mark.
  n := expire_stale_records();
  select * into r from credit_checks where ref = 'PM-EX1';
  if r.status <> 'expired' or r.expired_at is null or r.expired_at < now() - interval '1 minute' then
    raise exception 'T21 FAIL: expiry not stamped: % %', r.status, r.expired_at;
  end if;
  select * into r from credit_checks where ref = 'PM-EX2';
  if r.expired_at is null or r.expired_at > now() - interval '52 days' or r.expired_at < now() - interval '54 days' then
    raise exception 'T21 FAIL: backfill wrong: %', r.expired_at;
  end if;

  -- 4. Server-only; the backup bucket is private with no read policy.
  if has_function_privilege('anon', 'public.purge_report(text)', 'execute')
     or has_function_privilege('authenticated', 'public.purge_report(text)', 'execute') then
    raise exception 'T21 FAIL: purge_report callable by a client role';
  end if;
  if not exists (select 1 from storage.buckets where id = 'file-backups' and public = false) then
    raise exception 'T21 FAIL: file-backups bucket missing or public';
  end if;
  if exists (select 1 from pg_policies where tablename = 'objects' and policyname ilike '%file-backups%') then
    raise exception 'T21 FAIL: a policy exposes file-backups';
  end if;
  raise notice 'T21 ok: report purge after 12 months keeps band + reference; expiry stamped and backfilled; backup bucket private';
end $$;
rollback;
