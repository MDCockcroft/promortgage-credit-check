-- ============================================================
-- DEPLOY ORDER: push the NEW admin.html / store.js BEFORE applying this. The August admin deletes
-- rows directly and listens to credit_checks realtime — both stop working once this runs. The new
-- front end works with or without this migration. mm-client calls claim_idv_round and falls back
-- to check-then-claim when it is absent (PGRST202).
-- ADDED (second pass, 2026-09-26 late): 9. claim_idv_round (atomic per-person IDV limit);
-- 10. thin realtime signal table (full rows no longer pushed to browsers); per-ID submission
-- throttle (5 / 24 h) in submit_credit_check; sweep moves abandoned IDV to idv_failed.
-- ============================================================
-- Pro Mortgage credit-check — hardening (apply AFTER 20260926_mortgagemax.sql)
-- Idempotent: safe to re-run. Paste into Supabase → SQL Editor → Run.
-- The whole file runs in ONE transaction: if any statement fails, nothing changes.
-- ============================================================
-- What this does:
--   1. Staff lose direct DELETE on credit_checks. Deletes go through mm-staff
--      delete-record, which also removes the stored PDF and writes a durable
--      'deleted' consent_events row (review findings 39 / C12).
--   2. consent_events.event CHECK gains 'deleted', so a destroy-on-request leaves
--      a permanent trace after the row itself is gone (finding 39).
--   3. New helper public.valid_sa_id(text): 13 digits, month 01-12, day 01-31,
--      Luhn — the exact rule the form uses (store.js validSaId). Not callable by
--      anon/authenticated; the SECURITY DEFINER RPCs call it.
--   4. otp_hash moves out of credit_checks (readable by every staff member, so a
--      6-digit code could be cracked offline) into credit_check_secrets.otp_hash,
--      which no client role can read (finding 29). Existing hashes are copied
--      across, then credit_checks.otp_hash is set to NULL for every row. The
--      column itself is KEPT (always NULL from now on) so clients selecting '*'
--      keep working. otp_expires / otp_attempts stay where they are (not secret).
--   5. submit_credit_check (replaces the 20260926 version; keeps
--      consents_presented, mm_person_id and the {ref, demo_otp} return):
--        * writes the OTP hash to credit_check_secrets (creates the secrets row);
--        * id_type 'said' must carry a valid SA ID (helper in 3), else it raises
--          'invalid_id_number' (store.js rethrows res.error.message, so the form's
--          submit .catch receives Error('invalid_id_number'));
--          id_type 'passport' must carry a passport number ('invalid_passport_number');
--          any other id_type raises 'invalid_id_type';
--        * mm_person_id is derived from id_type ONLY — said → id_number,
--          passport → passport_number — and the other number is stored as NULL,
--          so a 'said' row can no longer smuggle a passport number through to the
--          vendor (findings 1 / 28).
--   6. confirm_consent (replaces the 20260926 version; keeps the one-time IDV
--      token: 32 random bytes, sha256 stored, 30-minute expiry, returned once):
--        * the attempt is COUNTED FIRST with a conditional update that only
--          succeeds while otp_attempts < 5, status = 'awaiting_otp' and the code
--          has not expired; the hash is compared only after that. Concurrent
--          guesses queue on the row lock, so at most 5 guesses are ever checked
--          per record and two correct codes can confirm (and mint a token) only
--          once (finding 32);
--        * the hash is read from credit_check_secrets and cleared there on success;
--        * a NULL p_otp is now a mismatch. Before, crypt(NULL, hash) is NULL, the
--          comparison was NULL and the mismatch branch was skipped — a NULL OTP
--          confirmed consent.
--   7. expire_stale_records (replaces the earlier version in this file):
--        * still expires awaiting_otp > 24 h and consent_confirmed > 7 days;
--        * ALSO expires idv_in_progress untouched for > 24 h (finding 38);
--        * does NOT expire consent_registered / idv_waived / idv_failed /
--          idv_passed — those may still be run by a consultant, however old;
--        * deletes the secrets row of every expired record, and clears any
--          leftover verification_request_number (status no longer
--          idv_in_progress) or otp_hash (status no longer awaiting_otp).
--   8. Index on credit_checks.mm_person_id for the per-person IDV limit (C5) and
--      the previous-withdrawal lookup in registerConsent (C6d).
--
-- ⚠️ Deploy order: the mm-staff delete-record code that inserts event 'deleted'
-- tolerates this migration not being applied yet (it logs and continues).
-- Nothing else in the Edge Functions depends on this file.
-- ============================================================

begin;

create extension if not exists pgcrypto;

-- ------------------------------------------------------------
-- 1. Deletes go through mm-staff delete-record, which also removes the stored
--    credit-report PDF. A direct REST delete by staff would orphan the PDF in
--    Storage (staff have no Storage delete right) and break the PCR declaration's
--    "destroy on request" undertaking. So staff lose direct DELETE.
-- ------------------------------------------------------------
revoke delete on table public.credit_checks from authenticated;

-- ------------------------------------------------------------
-- 2. consent_events may record a deletion. The 20260926 CHECK was declared
--    inline, so its name is generated; drop whichever CHECK covers "event".
-- ------------------------------------------------------------
do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
     where conrelid = 'public.consent_events'::regclass
       and contype = 'c'
       and pg_get_constraintdef(oid) like '%event%'
  loop
    execute format('alter table public.consent_events drop constraint %I', c.conname);
  end loop;
end $$;
alter table public.consent_events add constraint consent_events_event_check
  check (event in ('registered', 'withdrawn', 'readback', 'deleted'));

-- ------------------------------------------------------------
-- 3. SA ID check — same rule as store.js validSaId (format, month, day, Luhn).
-- ------------------------------------------------------------
create or replace function public.valid_sa_id(p_id text)
returns boolean
language plpgsql immutable set search_path = public
as $$
declare
  v_sum int := 0;
  v_d   int;
  v_mm  int;
  v_dd  int;
  i     int;
begin
  if p_id is null or p_id !~ '^[0-9]{13}$' then
    return false;
  end if;
  v_mm := substr(p_id, 3, 2)::int;
  v_dd := substr(p_id, 5, 2)::int;
  if v_mm < 1 or v_mm > 12 or v_dd < 1 or v_dd > 31 then
    return false;
  end if;
  -- Luhn, counting from the right-most digit (position 0); double odd positions.
  for i in 0..12 loop
    v_d := substr(p_id, 13 - i, 1)::int;
    if i % 2 = 1 then
      v_d := v_d * 2;
      if v_d > 9 then v_d := v_d - 9; end if;
    end if;
    v_sum := v_sum + v_d;
  end loop;
  return v_sum % 10 = 0;
end $$;

-- ------------------------------------------------------------
-- 4. OTP hash lives with the other secrets (RLS on, no policies, no grants).
-- ------------------------------------------------------------
alter table public.credit_check_secrets
  add column if not exists otp_hash text;

-- ------------------------------------------------------------
-- 5. submit_credit_check
-- ------------------------------------------------------------
create or replace function public.submit_credit_check(payload jsonb)
returns jsonb
language plpgsql security definer set search_path = public, extensions
as $$
declare
  v_ref       text;
  v_otp       text;
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

  -- Per ID/passport number per 24 hours (bug-hunt #3): at most 5 applications that PROVED the SMS
  -- code (those are what open consent registration / identity questions), and at most 20 that
  -- never did. Counting only confirmed rows toward the 5 means a stranger who merely knows
  -- someone's ID number cannot lock that person out by submitting junk.
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
  v_otp := lpad((floor(random() * 1000000))::int::text, 6, '0');

  insert into credit_checks (
    ref, first_names, surname, id_type, id_number, passport_number, date_of_birth,
    email, cell, home_phone, work_phone,
    street, suburb, city, province, postal_code,
    employment_status, marital_status, referral,
    gross_income, total_deductions, monthly_expenses, housing_payment,
    consent_ua, otp_expires, audit,
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
    now() + interval '10 minutes',
    jsonb_build_array(jsonb_build_object(
      'at', (extract(epoch from now()) * 1000)::bigint,
      'event', 'Form submitted by client')),
    case v_id_type when 'said' then v_id_number else v_passport end,
    case when jsonb_typeof(payload->'consentsPresented') = 'array'
         then payload->'consentsPresented' end
  );

  -- Secrets row after the parent row (FK). Only its hash is ever stored.
  insert into credit_check_secrets (ref, otp_hash, updated_at)
  values (v_ref, crypt(v_otp, gen_salt('bf')), now())
  on conflict (ref) do update set
    otp_hash   = excluded.otp_hash,
    updated_at = now();

  -- SMS PHASE TODO: send v_otp via the SMS gateway and REMOVE demo_otp
  -- from this return value (BUILD-PLAN §6 — go-live blocker).
  return jsonb_build_object('ref', v_ref, 'demo_otp', v_otp);
end $$;

-- ------------------------------------------------------------
-- 6. confirm_consent — count the attempt first, then compare.
-- ------------------------------------------------------------
create or replace function public.confirm_consent(p_ref text, p_otp text)
returns jsonb
language plpgsql security definer set search_path = public, extensions
as $$
declare
  r       record;
  v_hash  text;
  v_token text;
begin
  -- Claim one of the 5 attempts atomically. A concurrent caller waits on the
  -- row lock and re-checks this WHERE against the committed row, so no more
  -- than 5 guesses can ever reach the comparison below (finding 32).
  update credit_checks set otp_attempts = otp_attempts + 1
   where ref = p_ref
     and status = 'awaiting_otp'
     and otp_attempts < 5
     and otp_expires is not null
     and now() <= otp_expires;
  if not found then
    select status, otp_attempts, otp_expires into r from credit_checks where ref = p_ref;
    if not found then
      return jsonb_build_object('ok', false, 'error', 'not_found');
    end if;
    if r.status <> 'awaiting_otp' then
      return jsonb_build_object('ok', false, 'error', 'already_confirmed');
    end if;
    if r.otp_attempts >= 5 then
      return jsonb_build_object('ok', false, 'error', 'too_many_attempts');
    end if;
    return jsonb_build_object('ok', false, 'error', 'expired');
  end if;

  select otp_hash into v_hash from credit_check_secrets where ref = p_ref;
  -- "is distinct from": crypt() is STRICT, so a NULL p_otp must not slip through.
  if v_hash is null or p_otp is null or crypt(p_otp, v_hash) is distinct from v_hash then
    return jsonb_build_object('ok', false, 'error', 'mismatch');
  end if;

  update credit_checks set
    status = 'consent_confirmed',
    consent_confirmed_at = now(),
    audit = audit || jsonb_build_object(
      'at', (extract(epoch from now()) * 1000)::bigint,
      'event', 'Consent confirmed via SMS one-time PIN')
  where ref = p_ref and status = 'awaiting_otp';
  if not found then
    -- Unreachable while we hold the row lock from the attempt claim; never mint a token here.
    return jsonb_build_object('ok', false, 'error', 'already_confirmed');
  end if;

  v_token := encode(gen_random_bytes(32), 'hex');
  insert into credit_check_secrets (ref, idv_token_hash, idv_token_expires, otp_hash, updated_at)
  values (p_ref, encode(digest(v_token, 'sha256'), 'hex'), now() + interval '30 minutes', null, now())
  on conflict (ref) do update set
    idv_token_hash    = excluded.idv_token_hash,
    idv_token_expires = excluded.idv_token_expires,
    otp_hash          = null,
    updated_at        = now();

  return jsonb_build_object('ok', true, 'ref', p_ref, 'idv_token', v_token);
end $$;

-- ------------------------------------------------------------
-- 4 (cont.). Move existing hashes across, then blank the readable column.
--    Runs after the RPCs are replaced, inside the same transaction, so no
--    new hash can land in credit_checks in between.
-- ------------------------------------------------------------
insert into public.credit_check_secrets (ref, otp_hash, updated_at)
select ref, otp_hash, now()
  from public.credit_checks
 where otp_hash is not null and status = 'awaiting_otp'
on conflict (ref) do update set
  otp_hash   = excluded.otp_hash,
  updated_at = now();

update public.credit_checks set otp_hash = null where otp_hash is not null;

-- ------------------------------------------------------------
-- 7. Abandoned applications become 'expired':
--      awaiting_otp     — no SMS code entered within 24 hours
--      consent_confirmed — confirmed but never registered within 7 days
--    idv_in_progress untouched for 24 hours → idv_failed {expired} (not 'expired').
--    consent_registered / idv_waived / idv_passed / idv_failed are NOT expired:
--    a consultant may still act on them.
--    Run manually, or schedule it (Database → Cron → "select public.expire_stale_records()"
--    daily) once pg_cron is enabled for the project.
-- ------------------------------------------------------------
create or replace function public.expire_stale_records()
returns int
language plpgsql security definer set search_path = public
as $$
declare n int;
begin
  update credit_checks set
    status = 'expired',
    audit = audit || jsonb_build_object(
      'at', (extract(epoch from now()) * 1000)::bigint,
      'event', 'Expired automatically (abandoned before completion)')
  where (status = 'awaiting_otp'      and created_at < now() - interval '24 hours')
     or (status = 'consent_confirmed' and consent_confirmed_at < now() - interval '7 days');
  get diagnostics n = row_count;

  -- Abandoned identity rounds get the SAME end state the Edge Functions' recovery gives them
  -- (idv_failed, expired) — a consultant may still override in 'optional' mode. Never 'expired'.
  update credit_checks set
    status = 'idv_failed',
    idv_result = jsonb_build_object('expired', true),
    audit = audit || jsonb_build_object(
      'at', (extract(epoch from now()) * 1000)::bigint,
      'event', 'Identity questions expired before they were answered (swept)')
  where status = 'idv_in_progress'
    and coalesce(idv_started_at, consent_registered_at, created_at) < now() - interval '24 hours';

  delete from credit_check_signals where at < now() - interval '2 days';

  delete from credit_check_secrets s using credit_checks c
   where s.ref = c.ref and c.status = 'expired';

  -- Leftovers on live records: a verification request number outside an IDV
  -- round, or an OTP hash once the SMS step is over.
  update credit_check_secrets s set
    verification_request_number = case when c.status = 'idv_in_progress'
                                       then s.verification_request_number end,
    otp_hash   = case when c.status = 'awaiting_otp' then s.otp_hash end,
    updated_at = now()
  from credit_checks c
  where s.ref = c.ref
    and (   (c.status <> 'idv_in_progress' and s.verification_request_number is not null)
         or (c.status <> 'awaiting_otp'    and s.otp_hash is not null));

  return n;
end $$;

-- ------------------------------------------------------------
-- 8. Per-person lookups (IDV 24-hour limit; previous-withdrawal check).
-- ------------------------------------------------------------
create index if not exists credit_checks_mm_person_id_idx
  on public.credit_checks (mm_person_id);

-- ------------------------------------------------------------
-- 9. Atomic identity-round claim (bug-hunt #3). One transaction takes a per-person advisory lock,
--    sums this person's rounds in the last 24 h, and claims the round on this ref — so a burst of
--    simultaneous idv-start calls across many applications cannot exceed p_max. Called by the
--    mm-client Edge Function (service role) only; it falls back to check-then-claim if absent.
-- ------------------------------------------------------------
create or replace function public.claim_idv_round(p_ref text, p_from text, p_max int)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_person text;
  v_rounds int;
  v_round  int;
begin
  select mm_person_id into v_person from credit_checks where ref = p_ref;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if v_person is not null then
    perform pg_advisory_xact_lock(hashtext('pm_idv:' || v_person));
    select coalesce(sum(idv_attempts), 0) into v_rounds from credit_checks
     where mm_person_id = v_person and idv_started_at > now() - interval '24 hours';
    if v_rounds >= p_max then return jsonb_build_object('ok', false, 'reason', 'limit'); end if;
  end if;
  update credit_checks set
    status = 'idv_in_progress', idv_questions = null, idv_result = null,
    idv_started_at = now(), idv_attempts = idv_attempts + 1,
    audit = audit || jsonb_build_object(
      'at', (extract(epoch from now()) * 1000)::bigint,
      'event', 'Identity questions requested (round ' || (idv_attempts + 1) || ')')
  where ref = p_ref and status = p_from
  returning idv_attempts into v_round;
  if not found then return jsonb_build_object('ok', false, 'reason', 'state'); end if;
  return jsonb_build_object('ok', true, 'round', v_round);
end $$;

-- ------------------------------------------------------------
-- 10. Thin live-refresh channel (bug-hunt #12). Realtime on credit_checks pushed FULL rows —
--     report_json, IDV questions — to every signed-in browser, unlogged. Instead publish a tiny
--     signal table {ref, status, at} written by a trigger; the admin page re-reads what it needs
--     (and logs report views). store.js subscribes to both, so nothing breaks before this runs.
-- ------------------------------------------------------------
create table if not exists public.credit_check_signals (
  id     bigint generated always as identity primary key,
  ref    text not null,
  status text,
  op     text not null,
  at     timestamptz not null default now()
);
alter table public.credit_check_signals enable row level security;
revoke all on table public.credit_check_signals from anon;
revoke insert, update, delete on table public.credit_check_signals from authenticated;
drop policy if exists staff_read on public.credit_check_signals;
create policy staff_read on public.credit_check_signals for select to authenticated using (true);

create or replace function public.signal_credit_check_change()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  insert into credit_check_signals (ref, status, op)
  values (coalesce(new.ref, old.ref), case when tg_op = 'DELETE' then null else new.status end, lower(tg_op));
  return null;
end $$;
revoke all on function public.signal_credit_check_change() from public, anon, authenticated;

drop trigger if exists credit_checks_signal on public.credit_checks;
create trigger credit_checks_signal
  after insert or update or delete on public.credit_checks
  for each row execute function public.signal_credit_check_change();

do $$
begin
  alter publication supabase_realtime add table public.credit_check_signals;
exception when duplicate_object then null;
end $$;
do $$
begin
  alter publication supabase_realtime drop table public.credit_checks;
exception when undefined_object then null;
end $$;

-- ------------------------------------------------------------
-- Grants (re-stated after every create or replace)
-- ------------------------------------------------------------
revoke all on function public.valid_sa_id(text) from public, anon, authenticated;
revoke all on function public.expire_stale_records() from public, anon, authenticated;
revoke all on function public.claim_idv_round(text, text, int) from public, anon, authenticated;
revoke all on function public.submit_credit_check(jsonb) from public;
revoke all on function public.confirm_consent(text, text) from public;
grant execute on function public.submit_credit_check(jsonb) to anon, authenticated;
grant execute on function public.confirm_consent(text, text) to anon, authenticated;
revoke all on table public.credit_check_secrets from anon, authenticated;

commit;

-- ------------------------------------------------------------
-- Verify (optional — run separately, AFTER the block above):
--
--   -- a) no readable OTP hashes remain; the secrets table holds them now
--   select count(*) as readable_hashes from credit_checks where otp_hash is not null;   -- expect 0
--   select count(*) as awaiting_without_hash
--     from credit_checks c left join credit_check_secrets s using (ref)
--    where c.status = 'awaiting_otp' and s.otp_hash is null;   -- expect 0
--
--   -- a2) a NULL code no longer confirms (was accepted before: crypt() is STRICT)
--   --     pick any awaiting_otp ref; expect {"ok": false, "error": "mismatch"}
--   -- select public.confirm_consent('<ref>', null);
--
--   -- b) SA ID helper agrees with the form (store.js validSaId)
--   select public.valid_sa_id('8001015009087') as valid_id,       -- expect true
--          public.valid_sa_id('8001015009088') as bad_luhn,       -- expect false
--          public.valid_sa_id('8013015009083') as bad_month,      -- expect false
--          public.valid_sa_id('80010150090')   as too_short,      -- expect false
--          public.valid_sa_id(null)            as null_id;        -- expect false
--
--   -- c) consent_events accepts 'deleted'
--   select pg_get_constraintdef(oid) from pg_constraint
--    where conrelid = 'public.consent_events'::regclass and contype = 'c';
--
--   -- d) grants: anon/authenticated may run only the two form RPCs
--   select p.proname, r.rolname,
--          has_function_privilege(r.rolname, p.oid, 'execute') as can_execute
--     from pg_proc p cross join (values ('anon'), ('authenticated')) r(rolname)
--    where p.pronamespace = 'public'::regnamespace
--      and p.proname in ('submit_credit_check','confirm_consent','valid_sa_id','expire_stale_records')
--    order by 1, 2;   -- expect true for the first two, false for the last two
--   select has_table_privilege('authenticated', 'public.credit_check_secrets', 'select');  -- false
--   select has_table_privilege('authenticated', 'public.credit_checks', 'delete');         -- false
--
--   -- e) sweep dry run: what expire_stale_records() would touch right now
--   select status, count(*) from credit_checks
--    where (status = 'awaiting_otp'      and created_at < now() - interval '24 hours')
--       or (status = 'consent_confirmed' and consent_confirmed_at < now() - interval '7 days')
--       or (status = 'idv_in_progress'
--           and coalesce(idv_started_at, consent_registered_at, created_at) < now() - interval '24 hours')
--    group by status;
-- ============================================================
