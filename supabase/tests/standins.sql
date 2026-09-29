-- Minimal stand-ins for the parts of Supabase the migrations touch, for a LOCAL throwaway Postgres.
-- Never run against a real project.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
grant usage on schema public to anon, authenticated, service_role;
-- Supabase grants every new object in public to all three roles; the migrations revoke from there.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;

create schema extensions;
create extension pgcrypto schema extensions;
grant usage on schema extensions to anon, authenticated, service_role;
grant execute on all functions in schema extensions to anon, authenticated, service_role;
alter database postgres set search_path = public, extensions;

create schema auth;
create table auth.users (id uuid primary key default gen_random_uuid(), email text);
-- The signed-in user, as PostgREST sets it: select set_config('request.jwt.claim.sub', '<uuid>', false)
create function auth.uid() returns uuid language sql stable
  as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;

create schema storage;
create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
alter table storage.objects enable row level security;
grant usage on schema storage to anon, authenticated, service_role;
grant select on storage.objects, storage.buckets to anon, authenticated;
grant all on storage.objects, storage.buckets to service_role;

create publication supabase_realtime;
