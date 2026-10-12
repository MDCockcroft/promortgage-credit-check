-- Tests for 20261001_confirm_and_cleanup.sql and 20261006_retire_otp_and_one_phone.sql.
-- Run by run-local.sh after every migration.
-- (pg_cron is not installed locally, so the schedule itself is checked on Supabase with the
--  verify queries at the end of the migration.)
do $$
declare n int;
begin
  -- The SMS step is gone (2026-10-12): nothing checks a code, logs an SMS, or links a phone to a person.
  select count(*) into n from pg_proc
   where proname in ('confirm_consent', 'submit_credit_check', 'claim_otp_send', 'record_sms_result', 'link_conflict');
  if n > 0 then raise exception 'T12 FAIL: % retired function(s) still exist', n; end if;
  if to_regclass('public.sms_log') is not null then raise exception 'T12 FAIL: sms_log still exists'; end if;
  select count(*) into n from information_schema.columns
   where table_schema = 'public' and table_name in ('credit_checks', 'credit_check_secrets') and column_name like 'otp%';
  if n > 0 then raise exception 'T12 FAIL: % otp column(s) still exist', n; end if;
  if exists (select 1 from pg_constraint where conname = 'one_person_per_cellphone') then
    raise exception 'T12 FAIL: the one-phone constraint still exists'; end if;
  if (select pg_get_constraintdef(oid) from pg_constraint where conname = 'credit_checks_status_check') like '%awaiting_otp%' then
    raise exception 'T12 FAIL: the status machine still allows awaiting_otp'; end if;
  -- Only the server may create an application or run the clean-up.
  if has_function_privilege('anon', 'public.submit_application(jsonb, text, int, int)', 'execute')
     or has_function_privilege('authenticated', 'public.submit_application(jsonb, text, int, int)', 'execute') then
    raise exception 'T12 FAIL: the public can call submit_application'; end if;
  if not has_function_privilege('service_role', 'public.submit_application(jsonb, text, int, int)', 'execute') then
    raise exception 'T12 FAIL: the server cannot call submit_application'; end if;
  if has_function_privilege('anon', 'public.expire_stale_records()', 'execute')
     or has_function_privilege('authenticated', 'public.expire_stale_records()', 'execute') then
    raise exception 'T12 FAIL: the public can call expire_stale_records'; end if;
  raise notice 'T12 ok: the SMS step and the one-phone rule are gone; only the server can submit an application or run the clean-up';
end $$;

do $$
declare n int;
begin
  -- The public can execute no function in schema public at all.
  select count(*) into n
    from pg_proc p join pg_namespace s on s.oid = p.pronamespace
   where s.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute');
  if n > 0 then
    raise exception 'T13 FAIL: anon can still execute % function(s): %', n,
      (select string_agg(p.proname, ', ') from pg_proc p join pg_namespace s on s.oid = p.pronamespace
        where s.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute'));
  end if;
  raise notice 'T13 ok: the public can execute no database function';
end $$;
