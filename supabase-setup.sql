-- ============================================================
-- Pro Mortgage credit-check tool — Supabase schema (run once)
-- Paste into: Supabase dashboard → SQL Editor → New query → Run
-- ============================================================
-- Security model:
--   * anon (the public form) has NO table access at all; it may only
--     EXECUTE two functions: submit_credit_check + confirm_consent.
--   * authenticated (staff) has full row access via RLS policy.
--   * OTPs are stored bcrypt-hashed, expire after 10 minutes,
--     and lock after 5 wrong attempts.
-- ============================================================

-- GUARD (added 2026-09-29): this file recreates "any signed-in user may read" rules. Once consultant
-- roles exist (20260930), running it again would let every consultant see every client, so it refuses.
do $$
begin
  if to_regclass('public.staff_members') is not null then
    raise exception 'STOP: % is older than this database. It must not be run after 20260930_consultant_roles.sql - it would reopen every client record to every consultant.', 'supabase-setup.sql';
  end if;
end $$;

create extension if not exists pgcrypto;

create table if not exists public.credit_checks (
  id uuid primary key default gen_random_uuid(),
  ref text unique not null,
  created_at timestamptz not null default now(),
  status text not null default 'awaiting_otp'
    check (status in ('awaiting_otp','consent_confirmed','report_requested')),

  -- applicant
  first_names text not null,
  surname text not null,
  id_type text not null check (id_type in ('said','passport')),
  id_number text,
  passport_number text,
  date_of_birth date,
  email text not null,
  cell text not null,
  home_phone text,
  work_phone text,
  street text not null,
  suburb text not null,
  city text not null,
  province text not null,
  postal_code text not null,
  employment_status text not null,
  marital_status text not null,
  referral text,
  gross_income numeric,
  total_deductions numeric,
  monthly_expenses numeric,
  housing_payment numeric,

  -- consent + OTP
  consent_confirmed_at timestamptz,
  consent_ua text,
  otp_hash text,
  otp_expires timestamptz,
  otp_attempts int not null default 0,

  audit jsonb not null default '[]'::jsonb
);

alter table public.credit_checks enable row level security;

-- Staff: any authenticated user is staff (public signups MUST stay
-- disabled in Authentication → Providers → Email → "Allow new users to sign up" = off).
drop policy if exists staff_all on public.credit_checks;
create policy staff_all on public.credit_checks
  for all to authenticated using (true) with check (true);

-- Belt and braces: anon gets no direct table privileges.
revoke all on table public.credit_checks from anon;

-- ------------------------------------------------------------
-- RPC 1: anonymous form submission
-- ------------------------------------------------------------
create or replace function public.submit_credit_check(payload jsonb)
returns jsonb
language plpgsql security definer set search_path = public, extensions
as $$
declare
  v_ref text;
  v_otp text;
begin
  v_ref := 'PM-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));
  v_otp := lpad((floor(random() * 1000000))::int::text, 6, '0');

  insert into credit_checks (
    ref, first_names, surname, id_type, id_number, passport_number, date_of_birth,
    email, cell, home_phone, work_phone,
    street, suburb, city, province, postal_code,
    employment_status, marital_status, referral,
    gross_income, total_deductions, monthly_expenses, housing_payment,
    consent_ua, otp_hash, otp_expires, audit
  ) values (
    v_ref,
    payload->>'firstNames', payload->>'surname', payload->>'idType',
    nullif(payload->>'idNumber',''), nullif(payload->>'passportNumber',''),
    nullif(payload->>'dateOfBirth','')::date,
    payload->>'email', payload->>'cell',
    nullif(payload->>'homePhone',''), nullif(payload->>'workPhone',''),
    payload->>'street', payload->>'suburb', payload->>'city',
    payload->>'province', payload->>'postalCode',
    payload->>'employmentStatus', payload->>'maritalStatus', nullif(payload->>'referral',''),
    nullif(payload->>'grossIncome','')::numeric,
    nullif(payload->>'totalDeductions','')::numeric,
    nullif(payload->>'monthlyExpenses','')::numeric,
    nullif(payload->>'housingPayment','')::numeric,
    payload->>'consentUA',
    crypt(v_otp, gen_salt('bf')),
    now() + interval '10 minutes',
    jsonb_build_array(jsonb_build_object(
      'at', (extract(epoch from now()) * 1000)::bigint,
      'event', 'Form submitted by client'))
  );

  -- SMS PHASE TODO: send v_otp to payload->>'cell' via the SMS gateway
  -- (edge function or pg_net webhook) and REMOVE demo_otp from this
  -- return value so the code is never exposed to the browser.
  return jsonb_build_object('ref', v_ref, 'demo_otp', v_otp);
end $$;

-- ------------------------------------------------------------
-- RPC 2: anonymous consent confirmation (OTP check server-side)
-- ------------------------------------------------------------
create or replace function public.confirm_consent(p_ref text, p_otp text)
returns jsonb
language plpgsql security definer set search_path = public, extensions
as $$
declare
  r record;
begin
  select * into r from credit_checks where ref = p_ref;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  if r.status <> 'awaiting_otp' then
    return jsonb_build_object('ok', false, 'error', 'already_confirmed');
  end if;
  if r.otp_attempts >= 5 then
    return jsonb_build_object('ok', false, 'error', 'too_many_attempts');
  end if;
  if now() > r.otp_expires then
    return jsonb_build_object('ok', false, 'error', 'expired');
  end if;
  if r.otp_hash is null or crypt(p_otp, r.otp_hash) <> r.otp_hash then
    update credit_checks set otp_attempts = otp_attempts + 1 where ref = p_ref;
    return jsonb_build_object('ok', false, 'error', 'mismatch');
  end if;

  update credit_checks set
    status = 'consent_confirmed',
    consent_confirmed_at = now(),
    otp_hash = null,
    audit = audit || jsonb_build_object(
      'at', (extract(epoch from now()) * 1000)::bigint,
      'event', 'Consent confirmed via SMS one-time PIN')
  where ref = p_ref;

  return jsonb_build_object('ok', true, 'ref', p_ref);
end $$;

-- Functions are executable by everyone by default — lock them down.
revoke all on function public.submit_credit_check(jsonb) from public;
revoke all on function public.confirm_consent(text, text) from public;
grant execute on function public.submit_credit_check(jsonb) to anon, authenticated;
grant execute on function public.confirm_consent(text, text) to anon, authenticated;

-- Live updates for the admin register (safe to re-run).
do $$
begin
  alter publication supabase_realtime add table public.credit_checks;
exception when duplicate_object then null;
end $$;
