-- Tests for 20261001_confirm_and_cleanup.sql. Run by run-local.sh after every migration.
-- (pg_cron is not installed locally, so the schedule itself is checked on Supabase with the
--  verify queries at the end of the migration.)
do $$
begin
  -- The public can no longer try SMS codes: only the Edge Functions (service role) can.
  if has_function_privilege('anon', 'public.confirm_consent(text,text)', 'execute') then
    raise exception 'T12 FAIL: anon can still call confirm_consent'; end if;
  if has_function_privilege('authenticated', 'public.confirm_consent(text,text)', 'execute') then
    raise exception 'T12 FAIL: a signed-in user can still call confirm_consent'; end if;
  if not has_function_privilege('service_role', 'public.confirm_consent(text,text)', 'execute') then
    raise exception 'T12 FAIL: the server cannot call confirm_consent'; end if;
  set local role anon;
  begin
    perform confirm_consent('PM-R1', '000000');
    raise exception 'T12 FAIL: anon called confirm_consent';
  exception when insufficient_privilege then null;
  end;
  reset role;
  -- The clean-up stays server-only too.
  if has_function_privilege('anon', 'public.expire_stale_records()', 'execute')
     or has_function_privilege('authenticated', 'public.expire_stale_records()', 'execute') then
    raise exception 'T12 FAIL: the public can call expire_stale_records'; end if;
  raise notice 'T12 ok: only the server can check an SMS code or run the clean-up';
end $$;

do $$
declare n int;
begin
  -- With confirm_consent closed, the public can execute no function in schema public at all.
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
