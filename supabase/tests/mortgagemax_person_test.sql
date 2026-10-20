-- Tests for 20261007_mortgagemax_person.sql. Run by run-local.sh after every migration. Rolled back.
begin;
do $$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'credit_checks' and column_name = 'bt_person_id') then
    raise exception 'T18 FAIL: credit_checks.bt_person_id is missing';
  end if;
  if not exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'credit_checks_bt_person_id_idx') then
    raise exception 'T18 FAIL: the bt_person_id index is missing';
  end if;
  -- The API log accepts the People API, and still refuses anything else.
  insert into mm_api_log (ref, api, method, path_redacted) values (null, 'people', 'GET', '/People/IdentityNumber');
  begin
    insert into mm_api_log (ref, api, method, path_redacted) values (null, 'other', 'GET', '/x');
    raise exception 'T18 FAIL: the API log accepted an unknown api';
  exception when check_violation then null;
  end;
  raise notice 'T18 ok: bt_person_id column + index; the API log accepts people';
end $$;
rollback;
