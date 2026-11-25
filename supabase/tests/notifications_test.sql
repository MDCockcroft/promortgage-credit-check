-- Tests for 20261011_notifications.sql. Run by run-local.sh after every migration. Rolled back.
begin;
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000c1', 'owner@test'),
  ('00000000-0000-0000-0000-0000000000c2', 'left@test');
insert into staff_members (user_id, role, active, link_code) values
  ('00000000-0000-0000-0000-0000000000c1', 'consultant', true,  'ntfyown1'),
  ('00000000-0000-0000-0000-0000000000c2', 'consultant', false, 'ntfyown2');
insert into credit_checks (ref, status, first_names, surname, id_type, email, cell, street, suburb, city,
    province, postal_code, employment_status, marital_status, consultant_id, id_document_path, id_document_source, created_at)
  values
  ('PM-N1', 'idv_passed',   'T', 'T', 'said', 't@x', '0820000041', 's', 's', 'c', 'p', '0000', 'e', 'm',
     '00000000-0000-0000-0000-0000000000c1', 'PM-N1/id.jpg', 'client', now()),
  ('PM-N2', 'idv_failed',   'T', 'T', 'said', 't@x', '0820000042', 's', 's', 'c', 'p', '0000', 'e', 'm',
     null, null, null, now()),
  ('PM-N3', 'idv_passed',   'T', 'T', 'said', 't@x', '0820000043', 's', 's', 'c', 'p', '0000', 'e', 'm',
     '00000000-0000-0000-0000-0000000000c2', null, null, now()),
  ('PM-N4', 'report_ready', 'T', 'T', 'said', 't@x', '0820000044', 's', 's', 'c', 'p', '0000', 'e', 'm',
     null, null, null, now()),
  ('PM-N5', 'idv_passed',   'T', 'T', 'said', 't@x', '0820000045', 's', 's', 'c', 'p', '0000', 'e', 'm',
     null, null, null, now() - interval '31 days');
insert into notification_log (ref, kind, first_seen_at) values ('PM-N1', 'ready', now() - interval '12 minutes');
do $$
declare r record; n int;
begin
  -- 1. An owned application goes to its owner, and carries what the log holds.
  select * into r from notification_candidates() where ref = 'PM-N1';
  if r.recipient_emails <> array['owner@test'] or not r.has_id_copy or r.id_copy_source <> 'client'
     or jsonb_array_length(r.log) <> 1 or r.log -> 0 ->> 'kind' <> 'ready' or r.log -> 0 ->> 'sent_at' is not null then
    raise exception 'T31 FAIL: owned candidate wrong: %', row_to_json(r);
  end if;
  -- 2. No owner: every active administrator.
  select * into r from notification_candidates() where ref = 'PM-N2';
  if r.recipient_emails is null or not ('admin@test' = any(r.recipient_emails)) or 'owner@test' = any(r.recipient_emails)
     or r.has_id_copy or r.log <> '[]'::jsonb then
    raise exception 'T31 FAIL: unowned candidate wrong: %', row_to_json(r);
  end if;
  -- 3. An owner whose login was switched off: the administrators instead.
  select * into r from notification_candidates() where ref = 'PM-N3';
  if 'left@test' = any(r.recipient_emails) or not ('admin@test' = any(r.recipient_emails)) then
    raise exception 'T31 FAIL: inactive owner was a recipient: %', r.recipient_emails;
  end if;
  -- 4. A finished application and one older than 30 days are not candidates.
  select count(*) into n from notification_candidates() where ref in ('PM-N4', 'PM-N5');
  if n <> 0 then raise exception 'T31 FAIL: % non-candidates listed', n; end if;
  -- 5. Deleting the application takes its log rows with it.
  delete from credit_checks where ref = 'PM-N1';
  if exists (select 1 from notification_log where ref = 'PM-N1') then raise exception 'T31 FAIL: log outlived the application'; end if;
  -- 6. Server-only.
  if has_table_privilege('authenticated', 'public.notification_log', 'select')
     or has_table_privilege('anon', 'public.notification_log', 'select')
     or has_function_privilege('authenticated', 'public.notification_candidates()', 'execute')
     or has_function_privilege('anon', 'public.notification_candidates()', 'execute')
     or not has_function_privilege('service_role', 'public.notification_candidates()', 'execute') then
    raise exception 'T31 FAIL: notification objects are reachable from the browser';
  end if;
  -- 7. The id type travels with the candidate (20261012).
  if (select id_type from notification_candidates() where ref = 'PM-N2') <> 'said' then raise exception 'T31 FAIL: id_type missing'; end if;
  raise notice 'T31 ok: notification candidates, recipients, 30-day window, cascade, server-only';
end $$;
rollback;
