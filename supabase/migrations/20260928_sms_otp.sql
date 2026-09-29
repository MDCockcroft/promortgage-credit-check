-- ============================================================
-- Pro Mortgage credit-check — SMS consent code (apply AFTER 20260927_hardening.sql)
-- Safe to re-run ONLY until 20260930_consultant_roles.sql is applied (it then refuses). Paste into Supabase → SQL Editor → Run.
-- The whole file runs in ONE transaction: if any statement fails, nothing changes.
-- ============================================================
-- DEPLOY ORDER (front end before migration):
--   1. deploy mm-client (new 'submit' + 'resend-otp' actions; works with or without this file);
--   2. push index.html / store.js (the form submits through mm-client, not the RPC);
--   3. apply this file. From here the browser can no longer call submit_credit_check — the
--      August/September page that still does would fail, which is why it must be gone first.
-- ============================================================
-- What this does:
--   1. submit_credit_check no longer makes or returns a code (demo_otp is gone). It also refuses
--      a cellphone number that is not a South African mobile ('invalid_cell'). Only the service
--      role may call it: anon/authenticated lose EXECUTE.
--   2. claim_otp_send (service role only) is the ONE place a code is made: under a row lock and
--      per-number / global advisory locks it checks state, the resend token, cooldown, sends per
--      application, sends per cellphone number and the daily circuit breaker; then stores the
--      bcrypt hash, restarts the 10-minute expiry and the 5 attempts, and writes the sms_log row
--      BEFORE the send (write-before-call, as D9). A resend replaces the hash: only the newest
--      code works.
--   3. record_sms_result (service role only) closes the sms_log row and adds the audit line staff
--      see. A failed send is not counted against the application's 3 sends and may be retried
--      after 15 s (still counted by the per-number and daily caps).
--   4. sms_log: service-role-only record of every send (no code, no text). Deleted with its
--      application (on delete cascade — destroy-on-request).
--   5. credit_checks.otp_sends / otp_sent_at (staff-readable, not secret);
--      credit_check_secrets.otp_session_hash (sha256 of the resend token handed to the browser
--      that submitted the form — nobody else can trigger resends to that number).
--   6. Codes come from gen_random_bytes, not random().
-- ============================================================

begin;
-- GUARD (added 2026-09-29): this file recreates "any signed-in user may read" rules. Once consultant
-- roles exist (20260930), running it again would let every consultant see every client, so it refuses.
do $$
begin
  if to_regclass('public.staff_members') is not null then
    raise exception 'STOP: % is older than this database. It must not be run after 20260930_consultant_roles.sql - it would reopen every client record to every consultant.', '20260928_sms_otp.sql';
  end if;
end $$;



create extension if not exists pgcrypto;

-- ------------------------------------------------------------
-- 5. Columns
-- ------------------------------------------------------------
alter table public.credit_checks
  add column if not exists otp_sends   int not null default 0,
  add column if not exists otp_sent_at timestamptz;

alter table public.credit_check_secrets
  add column if not exists otp_session_hash text;

-- ------------------------------------------------------------
-- 4. sms_log — RLS on, no policies, no client grants.
-- ------------------------------------------------------------
create table if not exists public.sms_log (
  id                bigserial primary key,
  ref               text not null references public.credit_checks(ref) on delete cascade,
  cell_e164         text not null,
  purpose           text not null default 'consent_code' check (purpose in ('consent_code')),
  send_no           int  not null,
  mode              text not null check (mode in ('mock', 'test', 'live')),
  status            text not null default 'pending' check (status in ('pending', 'sent', 'failed', 'unknown')),
  http_status       int,
  provider_event_id text,
  error_code        text,
  cost              numeric,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
alter table public.sms_log enable row level security;
create index if not exists sms_log_cell_created_idx on public.sms_log (cell_e164, created_at);
create index if not exists sms_log_created_idx on public.sms_log (created_at);
create index if not exists sms_log_ref_idx on public.sms_log (ref);

-- ------------------------------------------------------------
-- South African mobile → 27XXXXXXXXX, or NULL. Same rule as the form (/^0[6-8][0-9]{8}$/),
-- also accepting +27 / 27 and spaces, dashes, brackets.
-- ------------------------------------------------------------
create or replace function public.sa_cell_e164(p_cell text)
returns text
language plpgsql immutable set search_path = public
as $$
declare d text := regexp_replace(coalesce(p_cell, ''), '[\s()+-]', '', 'g');
begin
  if d ~ '^0[6-8][0-9]{8}$' then return '27' || substr(d, 2); end if;
  if d ~ '^27[6-8][0-9]{8}$' then return d; end if;
  return null;
end $$;

-- ------------------------------------------------------------
-- 1. submit_credit_check — as 20260927, minus the code; plus the cellphone check.
-- ------------------------------------------------------------
create or replace function public.submit_credit_check(payload jsonb)
returns jsonb
language plpgsql security definer set search_path = public, extensions
as $$
declare
  v_ref       text;
  v_id_type   text := payload->>'idType';
  v_id_number text := nullif(btrim(coalesce(payload->>'idNumber', '')), '');
  v_passport  text := nullif(btrim(coalesce(payload->>'passportNumber', '')), '');
begin
  -- The form validates these too; this stops a crafted payload (findings 1 / 28).
  if v_id_type = 'said' then
    if not public.valid_sa_id(v_id_number) then
      raise exception 'invalid_id_number'
        using errcode = '22023', hint = 'Enter a valid 13-digit South African ID number.';
    end if;
    v_passport := null;
  elsif v_id_type = 'passport' then
    if v_passport is null then
      raise exception 'invalid_passport_number'
        using errcode = '22023', hint = 'Enter the passport number.';
    end if;
    v_id_number := null;
  else
    raise exception 'invalid_id_type' using errcode = '22023';
  end if;

  -- The consent code goes to this number; anything but an SA mobile cannot receive it.
  if public.sa_cell_e164(payload->>'cell') is null then
    raise exception 'invalid_cell'
      using errcode = '22023', hint = 'Enter a valid SA cellphone number, e.g. 0821234567.';
  end if;

  -- Per ID/passport number per 24 hours (bug-hunt #3): at most 5 applications that PROVED the SMS
  -- code, and at most 20 that never did (junk cannot lock a person out).
  if (select count(*) from credit_checks
       where mm_person_id = case v_id_type when 'said' then v_id_number else v_passport end
         and created_at > now() - interval '24 hours'
         and consent_confirmed_at is not null) >= 5
     or (select count(*) from credit_checks
       where mm_person_id = case v_id_type when 'said' then v_id_number else v_passport end
         and created_at > now() - interval '24 hours'
         and consent_confirmed_at is null) >= 20 then
    raise exception 'too_many_submissions'
      using errcode = '22023', hint = 'Please contact your consultant directly.';
  end if;

  v_ref := 'PM-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));

  -- otp_expires stays NULL until claim_otp_send issues a code, so confirm_consent refuses
  -- every guess before then.
  insert into credit_checks (
    ref, first_names, surname, id_type, id_number, passport_number, date_of_birth,
    email, cell, home_phone, work_phone,
    street, suburb, city, province, postal_code,
    employment_status, marital_status, referral,
    gross_income, total_deductions, monthly_expenses, housing_payment,
    consent_ua, audit,
    mm_person_id, consents_presented
  ) values (
    v_ref,
    payload->>'firstNames', payload->>'surname', v_id_type,
    v_id_number, v_passport,
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
    jsonb_build_array(jsonb_build_object(
      'at', (extract(epoch from now()) * 1000)::bigint,
      'event', 'Form submitted by client')),
    case v_id_type when 'said' then v_id_number else v_passport end,
    case when jsonb_typeof(payload->'consentsPresented') = 'array'
         then payload->'consentsPresented' end
  );

  return jsonb_build_object('ref', v_ref);
end $$;

-- ------------------------------------------------------------
-- 2. claim_otp_send — make a code and reserve the send, atomically.
--    p_session_hash: sha256 of the resend token. First send: stored. Resend: must match.
--    Returns {ok:true, code, cell, sms_id, send_no}
--         or {ok:false, reason: not_found|invalid_state|forbidden|cooldown|too_many_sends|
--                               bad_cell|cell_limit|daily_limit, retry_after?}
-- ------------------------------------------------------------
create or replace function public.claim_otp_send(
  p_ref text, p_session_hash text, p_is_resend boolean, p_mode text,
  p_cooldown_s int, p_max_sends int, p_cell_max int, p_daily_max int)
returns jsonb
language plpgsql security definer set search_path = public, extensions
as $$
declare
  r       record;
  v_cell  text;
  v_code  text;
  v_wait  int;
  v_id    bigint;
  v_hash  text;
begin
  if p_session_hash is null or length(p_session_hash) < 32 then
    return jsonb_build_object('ok', false, 'reason', 'forbidden');
  end if;

  select ref, status, cell, otp_sends, otp_sent_at into r
    from credit_checks where ref = p_ref for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if r.status <> 'awaiting_otp' then
    return jsonb_build_object('ok', false, 'reason', 'invalid_state');
  end if;

  select otp_session_hash into v_hash from credit_check_secrets where ref = p_ref;
  if p_is_resend then
    if v_hash is null or v_hash <> p_session_hash then
      return jsonb_build_object('ok', false, 'reason', 'forbidden');
    end if;
  elsif r.otp_sends > 0 or v_hash is not null then
    -- The first send happens once, inside the submit request that created the row.
    return jsonb_build_object('ok', false, 'reason', 'forbidden');
  end if;

  if r.otp_sent_at is not null and r.otp_sent_at > now() - make_interval(secs => p_cooldown_s) then
    v_wait := ceil(extract(epoch from (r.otp_sent_at + make_interval(secs => p_cooldown_s) - now())))::int;
    return jsonb_build_object('ok', false, 'reason', 'cooldown', 'retry_after', greatest(v_wait, 1));
  end if;
  if r.otp_sends >= p_max_sends then
    return jsonb_build_object('ok', false, 'reason', 'too_many_sends');
  end if;

  v_cell := public.sa_cell_e164(r.cell);
  if v_cell is null then
    return jsonb_build_object('ok', false, 'reason', 'bad_cell');
  end if;

  -- Per-number and global counts under advisory locks, so a burst across many applications
  -- cannot slip past either limit (same pattern as claim_idv_round).
  perform pg_advisory_xact_lock(hashtext('sms_cell:' || v_cell));
  if (select count(*) from sms_log
       where cell_e164 = v_cell and created_at > now() - interval '24 hours') >= p_cell_max then
    return jsonb_build_object('ok', false, 'reason', 'cell_limit');
  end if;
  perform pg_advisory_xact_lock(hashtext('sms_global'));
  if (select count(*) from sms_log where created_at > now() - interval '24 hours') >= p_daily_max then
    return jsonb_build_object('ok', false, 'reason', 'daily_limit');
  end if;

  -- 6 digits from the CSPRNG (4 bytes mod 10^6: bias < 0.03%).
  v_code := lpad(((('x' || encode(gen_random_bytes(4), 'hex'))::bit(32)::bigint % 1000000))::text, 6, '0');

  insert into credit_check_secrets (ref, otp_hash, otp_session_hash, updated_at)
  values (p_ref, crypt(v_code, gen_salt('bf')), p_session_hash, now())
  on conflict (ref) do update set
    otp_hash         = excluded.otp_hash,
    otp_session_hash = excluded.otp_session_hash,
    updated_at       = now();

  update credit_checks set
    otp_expires  = now() + interval '10 minutes',
    otp_attempts = 0,
    otp_sends    = otp_sends + 1,
    otp_sent_at  = now()
  where ref = p_ref;

  insert into sms_log (ref, cell_e164, send_no, mode)
  values (p_ref, v_cell, r.otp_sends + 1, p_mode)
  returning id into v_id;

  return jsonb_build_object('ok', true, 'code', v_code, 'cell', v_cell,
                            'sms_id', v_id, 'send_no', r.otp_sends + 1);
end $$;

-- ------------------------------------------------------------
-- 3. record_sms_result — close the log row; tell staff what happened.
-- ------------------------------------------------------------
create or replace function public.record_sms_result(
  p_sms_id bigint, p_status text, p_http int, p_event_id text, p_error text, p_cost numeric)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  l     record;
  v_evt text;
begin
  update sms_log set
    status = p_status, http_status = p_http, provider_event_id = p_event_id,
    error_code = left(p_error, 80), cost = p_cost, updated_at = now()
  where id = p_sms_id and status = 'pending'
  returning ref, send_no, mode into l;
  if not found then return; end if;

  v_evt := case p_status
    when 'sent'    then 'Consent code sent by SMS'
    when 'unknown' then 'Consent code SMS timed out (it may still arrive)'
    else 'Consent code SMS could not be sent (' || coalesce(left(p_error, 80), 'error') || ')'
  end || case when l.send_no > 1 then ' — resend ' || (l.send_no - 1) else '' end
      || case when l.mode <> 'live' then ' [' || l.mode || ' mode]' else '' end;

  -- A failed send (provider outage, no credits) does not use up one of the application's sends,
  -- and the next try is allowed after 15 s instead of the full 60 s cooldown (mm-client uses 60).
  -- Failed attempts still count toward the per-number and daily caps (sms_log), which bound abuse.
  update credit_checks set
    otp_sends   = case when p_status = 'failed' then greatest(otp_sends - 1, 0) else otp_sends end,
    otp_sent_at = case when p_status = 'failed' then now() - interval '45 seconds' else otp_sent_at end,
    audit = audit || jsonb_build_object('at', (extract(epoch from now()) * 1000)::bigint, 'event', v_evt)
  where ref = l.ref;
end $$;

-- ------------------------------------------------------------
-- Grants (re-stated after every create or replace)
-- ------------------------------------------------------------
revoke all on function public.submit_credit_check(jsonb) from public, anon, authenticated;
revoke all on function public.sa_cell_e164(text) from public, anon, authenticated;
revoke all on function public.claim_otp_send(text, text, boolean, text, int, int, int, int) from public, anon, authenticated;
revoke all on function public.record_sms_result(bigint, text, int, text, text, numeric) from public, anon, authenticated;
grant execute on function public.submit_credit_check(jsonb) to service_role;
grant execute on function public.sa_cell_e164(text) to service_role;
grant execute on function public.claim_otp_send(text, text, boolean, text, int, int, int, int) to service_role;
grant execute on function public.record_sms_result(bigint, text, int, text, text, numeric) to service_role;
revoke all on table public.sms_log from anon, authenticated;
revoke all on sequence public.sms_log_id_seq from anon, authenticated;
-- confirm_consent stays anon-callable: it only compares a code against a hash it never returns.

commit;

-- ------------------------------------------------------------
-- Verify (optional — run separately, AFTER the block above):
--
--   -- a) the browser roles can no longer submit or make codes
--   select p.proname, r.rolname, has_function_privilege(r.rolname, p.oid, 'execute') as can_execute
--     from pg_proc p cross join (values ('anon'), ('authenticated'), ('service_role')) r(rolname)
--    where p.pronamespace = 'public'::regnamespace
--      and p.proname in ('submit_credit_check', 'claim_otp_send', 'record_sms_result', 'confirm_consent')
--    order by 1, 2;   -- anon/authenticated: true ONLY for confirm_consent; service_role: true
--   select has_table_privilege('authenticated', 'public.sms_log', 'select');   -- false
--
--   -- b) cellphone rule
--   select public.sa_cell_e164('082 123 4567'), public.sa_cell_e164('+27821234567'),
--          public.sa_cell_e164('0121234567'), public.sa_cell_e164(null);
--   -- expect 27821234567, 27821234567, NULL, NULL
-- ============================================================
