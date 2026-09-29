-- ============================================================
-- Pro Mortgage credit-check — MortgageMax integration migration
-- Run AFTER supabase-setup.sql. Safe to re-run ONLY until 20260930_consultant_roles.sql is applied (it then refuses).
-- Paste into: Supabase dashboard → SQL Editor → New query → Run
-- See BUILD-PLAN.md §1 (decisions) and §2 (flow + status machine).
-- ============================================================
-- What this does:
--   1. Widens the status machine for consent → IDV → credit check.
--   2. Adds the MortgageMax columns to credit_checks.
--   3. Moves bearer-like secrets (IDV token hash, verification request
--      number) into credit_check_secrets, which NO client role can read.
--   4. Adds append-only evidence tables: mm_api_log, consent_events,
--      report_access_log; plus staff_profiles for the consultant details
--      MortgageMax requires on each credit check.
--   5. Creates the private Storage bucket for report PDFs.
--   6. Makes status transitions function-only: staff keep SELECT and
--      DELETE but lose direct INSERT/UPDATE (BUILD-PLAN D10).
--   7. confirm_consent now mints a one-time IDV token; submit stores the
--      consent types shown and the MortgageMax personId.
--
-- ⚠️ After this runs, admin.html's old "Request ITC report" button stops
-- working (it updated status from the browser). That is intended — it is
-- replaced by the mm-staff Edge Function in BUILD-PLAN Step 7/9.
-- ============================================================

-- GUARD (added 2026-09-29): this file recreates "any signed-in user may read" rules. Once consultant
-- roles exist (20260930), running it again would let every consultant see every client, so it refuses.
do $$
begin
  if to_regclass('public.staff_members') is not null then
    raise exception 'STOP: % is older than this database. It must not be run after 20260930_consultant_roles.sql - it would reopen every client record to every consultant.', '20260926_mortgagemax.sql';
  end if;
end $$;

create extension if not exists pgcrypto;

-- ------------------------------------------------------------
-- 1. Status machine
-- ------------------------------------------------------------
alter table public.credit_checks drop constraint if exists credit_checks_status_check;
alter table public.credit_checks add constraint credit_checks_status_check
  check (status in (
    'awaiting_otp', 'consent_confirmed', 'consent_registered',
    'idv_in_progress', 'idv_passed', 'idv_failed', 'idv_unavailable', 'idv_waived',
    'check_in_flight', 'report_ready', 'check_failed',
    'consent_withdrawn', 'manual_required', 'expired', 'config_error',
    'report_requested'  -- legacy value from the stub; no longer written
  ));

-- ------------------------------------------------------------
-- 2. MortgageMax columns (all nullable; filled by Edge Functions)
-- ------------------------------------------------------------
alter table public.credit_checks
  -- consent
  add column if not exists mm_person_id           text,         -- = ID/passport number (D5); never logged
  add column if not exists consents_presented     jsonb,        -- [{id, version, hash}] shown on the form (D13)
  add column if not exists consent_registered_at  timestamptz,
  add column if not exists mm_consents_snapshot   jsonb,        -- last GET /Consents read-back (D6)
  add column if not exists mm_consents_synced_at  timestamptz,
  add column if not exists consent_withdrawn_at   timestamptz,
  -- IDV (never the answers, never the verification request number)
  add column if not exists idv_attempts           int not null default 0,
  add column if not exists idv_started_at         timestamptz,
  add column if not exists idv_questions          jsonb,
  add column if not exists idv_result             jsonb,
  add column if not exists idv_passed_at          timestamptz,
  add column if not exists verification_success_code text,
  -- credit check
  add column if not exists check_started_at       timestamptz,
  add column if not exists check_request_id       uuid,
  add column if not exists check_attempt          int not null default 0,
  add column if not exists check_requested_by     uuid,
  add column if not exists check_error_code       text,
  add column if not exists check_error_text       text,
  add column if not exists group_id               text,
  add column if not exists bureau_enquiry_id      text,
  add column if not exists report_json            jsonb,
  add column if not exists report_summary         jsonb,        -- normalised Tier 1 verdict (report-model.js)
  add column if not exists affordability_json     jsonb,
  add column if not exists report_ready_at        timestamptz,
  add column if not exists pdf_status             text,
  add column if not exists pdf_attempts           int not null default 0,
  add column if not exists report_pdf_path        text,
  add column if not exists mm_env                 text;

alter table public.credit_checks drop constraint if exists credit_checks_pdf_status_check;
alter table public.credit_checks add constraint credit_checks_pdf_status_check
  check (pdf_status is null or pdf_status in ('pending','fetching','stored','failed','locked'));

-- ------------------------------------------------------------
-- 3. Secrets table — no policies, so only the service role and
--    SECURITY DEFINER functions can touch it.
-- ------------------------------------------------------------
create table if not exists public.credit_check_secrets (
  ref                         text primary key references public.credit_checks(ref) on delete cascade,
  idv_token_hash              text,
  idv_token_expires           timestamptz,
  verification_request_number text,
  updated_at                  timestamptz not null default now()
);
alter table public.credit_check_secrets enable row level security;
revoke all on table public.credit_check_secrets from anon, authenticated;

-- ------------------------------------------------------------
-- 4. Evidence + profile tables
-- ------------------------------------------------------------
-- Every vendor call, written BEFORE parsing (D9). PII-redacted.
create table if not exists public.mm_api_log (
  id            bigint generated always as identity primary key,
  created_at    timestamptz not null default now(),
  ref           text,
  request_id    uuid,
  api           text not null check (api in ('credit','consent')),
  method        text not null,
  path_redacted text not null,
  http_status   int,
  content_type  text,
  body_head     text,          -- first ~8 KB, personId/idNumber redacted
  vendor_code   text,
  trace_id      text,
  latency_ms    int,
  mm_env        text
);
create index if not exists mm_api_log_ref_idx on public.mm_api_log (ref, created_at desc);

-- Immutable consent evidence: our copy survives the vendor's replace-on-write (D6).
create table if not exists public.consent_events (
  id                  bigint generated always as identity primary key,
  created_at          timestamptz not null default now(),
  ref                 text not null,
  event               text not null check (event in ('registered','withdrawn','readback')),
  consent_type_id     text,
  consent_version     text,
  declaration_hash    text,
  granted             boolean,
  otp_confirmed_at    timestamptz,
  request_body        jsonb,     -- personId redacted
  response_body       text,
  vendor_created_date timestamptz,
  created_by          text
);
create index if not exists consent_events_ref_idx on public.consent_events (ref, created_at);

-- Who viewed or downloaded which report (PCR declaration undertaking).
create table if not exists public.report_access_log (
  id         bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  ref        text not null,
  user_id    uuid not null default auth.uid(),
  action     text not null check (action in ('view','download_pdf','view_raw'))
);
create index if not exists report_access_log_ref_idx on public.report_access_log (ref, created_at desc);

-- Consultant details sent as userDetails on /CreditCheck/full.
create table if not exists public.staff_profiles (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  full_name   text not null,
  email       text not null,
  cell        text,
  branch_name text,
  updated_at  timestamptz not null default now()
);

alter table public.mm_api_log        enable row level security;
alter table public.consent_events    enable row level security;
alter table public.report_access_log enable row level security;
alter table public.staff_profiles    enable row level security;

revoke all on table public.mm_api_log, public.consent_events,
                    public.report_access_log, public.staff_profiles from anon;

-- Staff can read the evidence; only the service role writes it.
drop policy if exists staff_read on public.mm_api_log;
create policy staff_read on public.mm_api_log for select to authenticated using (true);
drop policy if exists staff_read on public.consent_events;
create policy staff_read on public.consent_events for select to authenticated using (true);
revoke insert, update, delete on table public.mm_api_log, public.consent_events from authenticated;

-- Access log: staff append their own entries and read all; never edit.
drop policy if exists staff_read on public.report_access_log;
create policy staff_read on public.report_access_log for select to authenticated using (true);
drop policy if exists staff_insert_own on public.report_access_log;
create policy staff_insert_own on public.report_access_log for insert to authenticated
  with check (user_id = auth.uid());
revoke update, delete on table public.report_access_log from authenticated;

-- Profiles: staff read all, manage only their own.
drop policy if exists staff_read on public.staff_profiles;
create policy staff_read on public.staff_profiles for select to authenticated using (true);
drop policy if exists staff_own on public.staff_profiles;
create policy staff_own on public.staff_profiles for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ------------------------------------------------------------
-- 5. Private bucket for report PDFs (service role writes; staff read
--    through short-lived signed URLs)
-- ------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('credit-reports', 'credit-reports', false, 20971520, array['application/pdf'])
on conflict (id) do nothing;

drop policy if exists "credit-reports staff read" on storage.objects;
create policy "credit-reports staff read" on storage.objects
  for select to authenticated using (bucket_id = 'credit-reports');

-- ------------------------------------------------------------
-- 6. Status transitions become function-only (D10)
-- ------------------------------------------------------------
revoke insert, update on table public.credit_checks from authenticated;
-- SELECT stays (register + realtime); DELETE stays (destroy on request).

-- ------------------------------------------------------------
-- 7. RPC changes
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
    consent_ua, otp_hash, otp_expires, audit,
    mm_person_id, consents_presented
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
      'event', 'Form submitted by client')),
    coalesce(nullif(payload->>'idNumber',''), nullif(payload->>'passportNumber','')),
    case when jsonb_typeof(payload->'consentsPresented') = 'array'
         then payload->'consentsPresented' end
  );

  -- SMS PHASE TODO: send v_otp via the SMS gateway and REMOVE demo_otp
  -- from this return value (BUILD-PLAN §6 — go-live blocker).
  return jsonb_build_object('ref', v_ref, 'demo_otp', v_otp);
end $$;

-- confirm_consent: unchanged checks, plus mints a one-time IDV token
-- (32 random bytes, sha256 stored, 30-minute expiry) returned ONCE.
create or replace function public.confirm_consent(p_ref text, p_otp text)
returns jsonb
language plpgsql security definer set search_path = public, extensions
as $$
declare
  r record;
  v_token text;
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

  v_token := encode(gen_random_bytes(32), 'hex');
  insert into credit_check_secrets (ref, idv_token_hash, idv_token_expires, updated_at)
  values (p_ref, encode(digest(v_token, 'sha256'), 'hex'), now() + interval '30 minutes', now())
  on conflict (ref) do update set
    idv_token_hash    = excluded.idv_token_hash,
    idv_token_expires = excluded.idv_token_expires,
    updated_at        = now();

  return jsonb_build_object('ok', true, 'ref', p_ref, 'idv_token', v_token);
end $$;

revoke all on function public.submit_credit_check(jsonb) from public;
revoke all on function public.confirm_consent(text, text) from public;
grant execute on function public.submit_credit_check(jsonb) to anon, authenticated;
grant execute on function public.confirm_consent(text, text) to anon, authenticated;

-- ------------------------------------------------------------
-- Verify (optional — run separately):
--   select column_name from information_schema.columns
--    where table_name = 'credit_checks' order by ordinal_position;
--   select tablename, rowsecurity from pg_tables
--    where schemaname = 'public' order by tablename;
-- ============================================================
