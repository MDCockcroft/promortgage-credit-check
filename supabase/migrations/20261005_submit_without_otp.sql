-- ============================================================
-- Pro Mortgage credit-check — applications no longer wait for an SMS code
-- (apply AFTER 20261004_manual_client_photo.sql; then deploy mm-client and push the pages;
--  then apply 20261006_retire_otp_and_one_phone.sql)
-- Idempotent: safe to re-run. Paste into Supabase → SQL Editor → Run. One transaction.
-- ============================================================
-- Why: MortgageMAX (Bennie Vermeulen, 2026-10-12): the identity questions alone verify the person;
-- the SMS code is not needed. The code was our consent evidence and the gate before the vendor
-- calls - never the identity check. From now on the client's acceptance of the consent declaration
-- on the form, in the same session that then answers the questions, is the evidence; the vendor's
-- own limit (two question rounds per ID number per 24 hours) and the consultant's link are the gate.
--
-- ORDER: this file is ADDITIVE (one new function; nothing the deployed code uses is changed), so
-- apply it FIRST. The new mm-client calls submit_application and fails safe ("Service is not
-- configured") until this file has run. The old objects (confirm_consent, submit_credit_check, the
-- SMS log, the OTP columns) are removed by 20261006 once the new code is live.
-- ============================================================
-- What this does:
--   1. submit_application(payload, link code): validates the application as submit_credit_check did
--      (ID number, passport, cellphone), requires the consent declaration to have been accepted and
--      an active consultant's link, creates the record already in consent_confirmed, and mints the
--      one-time identity-check session token in the same transaction (sha256 stored, 30-minute
--      expiry - what confirm_consent used to do after the code was entered). Returns {ref, idv_token}.
--      Service role only.
--   2. Limits, now that no SMS code bounds how many people one link-holder can start applications
--      for (a consultant's link is not secret - they send it to every client): per person AND link
--      5 per 24 h (a stranger using another link cannot lock a person out); per link 30 per 24 h;
--      300 per 24 h in all (the circuit breaker the SMS gateway used to be). The caps are parameters
--      with defaults, so mm-client can pass other values without a migration. Counted under a
--      per-person advisory lock, so parallel submissions cannot slip past the cap.
--   3. The one-cellphone-one-person constraint goes here, not in 20261006: Michael withdrew the rule,
--      and the new submit sets consent_confirmed_at at once, which would trip the constraint.
-- ============================================================

begin;

-- The rule is withdrawn (Michael, 2026-10-12); the function below sets consent_confirmed_at on insert.
alter table public.credit_checks drop constraint if exists one_person_per_cellphone;

drop function if exists public.submit_application(jsonb);

create or replace function public.submit_application(
  payload jsonb, p_consultant_code text, p_link_max int default 30, p_daily_max int default 300
) returns jsonb
language plpgsql security definer set search_path = public, extensions
as $$
declare
  v_ref        text;
  v_token      text;
  v_id_type    text := payload->>'idType';
  v_id_number  text := nullif(btrim(coalesce(payload->>'idNumber', '')), '');
  v_passport   text := nullif(btrim(coalesce(payload->>'passportNumber', '')), '');
  v_person     text;
  v_consultant uuid;
begin
  -- The consent declaration must have been accepted on the form. (What the server can know is that
  -- the submitter said so - as before; the identity questions in the same session are what prove
  -- the person is who they say.)
  if payload->>'consentAccepted' is distinct from 'true' then
    raise exception 'consent_required' using errcode = '22023';
  end if;

  -- Only through an active consultant's personal link (Michael, 2026-10-01).
  select m.user_id into v_consultant
    from staff_members m
   where p_consultant_code ~ '^[a-z0-9]{8}$' and m.link_code = p_consultant_code and m.active;
  if v_consultant is null then
    raise exception 'consultant_link_required' using errcode = '22023';
  end if;

  -- The form validates these too; this stops a crafted payload.
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

  -- The cellphone is the consultant's contact number for the client: it must still be a real SA mobile.
  if public.sa_cell_e164(payload->>'cell') is null then
    raise exception 'invalid_cell'
      using errcode = '22023', hint = 'Enter a valid SA cellphone number, e.g. 0821234567.';
  end if;

  v_person := case v_id_type when 'said' then v_id_number else v_passport end;

  -- Serialise the counts below per person, then per link (always this order), so a burst of
  -- simultaneous submissions cannot exceed a cap.
  perform pg_advisory_xact_lock(hashtext('pm_submit_person:' || v_person));
  perform pg_advisory_xact_lock(hashtext('pm_submit_link:' || v_consultant::text));

  -- Per person AND consultant link, per 24 hours: at most 5. Every application goes straight to
  -- consent registration and the identity questions (MortgageMAX caps those at two rounds per person
  -- per 24 hours itself). Scoped to the link so a stranger holding a different consultant's link
  -- cannot lock a person out of applying through their own consultant.
  if (select count(*) from credit_checks
       where mm_person_id = v_person and consultant_id = v_consultant
         and created_at > now() - interval '24 hours') >= 5 then
    raise exception 'too_many_submissions'
      using errcode = '22023', hint = 'Please contact your consultant directly.';
  end if;
  -- Per link per 24 hours, and in all per 24 hours: what bounds a leaked link, and the whole system.
  if (select count(*) from credit_checks
       where consultant_id = v_consultant and created_at > now() - interval '24 hours') >= p_link_max
     or (select count(*) from credit_checks where created_at > now() - interval '24 hours') >= p_daily_max then
    raise exception 'too_many_applications'
      using errcode = '22023', hint = 'Please contact your consultant directly.';
  end if;

  v_ref := 'PM-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));

  insert into credit_checks (
    ref, status, consent_confirmed_at,
    first_names, surname, id_type, id_number, passport_number, date_of_birth,
    email, cell, home_phone, work_phone,
    street, suburb, city, province, postal_code,
    employment_status, marital_status, referral,
    gross_income, total_deductions, monthly_expenses, housing_payment,
    consent_ua, audit,
    mm_person_id, consents_presented
  ) values (
    v_ref, 'consent_confirmed', now(),
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
    jsonb_build_array(
      jsonb_build_object('at', (extract(epoch from now()) * 1000)::bigint, 'event', 'Form submitted by client'),
      jsonb_build_object('at', (extract(epoch from now()) * 1000)::bigint,
        'event', 'Consent declaration accepted on the form (identity is verified by the questions that follow)')),
    v_person,
    case when jsonb_typeof(payload->'consentsPresented') = 'array'
         then payload->'consentsPresented' end
  );

  -- The one-time identity-check session token, exactly as confirm_consent minted it: only the hash
  -- is stored; the token goes back to the submitting browser once.
  v_token := encode(gen_random_bytes(32), 'hex');
  insert into credit_check_secrets (ref, idv_token_hash, idv_token_expires, updated_at)
  values (v_ref, encode(digest(v_token, 'sha256'), 'hex'), now() + interval '30 minutes', now());

  return jsonb_build_object('ref', v_ref, 'idv_token', v_token);
end $$;

revoke all on function public.submit_application(jsonb, text, int, int) from public, anon, authenticated;
grant execute on function public.submit_application(jsonb, text, int, int) to service_role;

commit;

-- ------------------------------------------------------------
-- Verify (run separately, AFTER the block above):
--
--   select has_function_privilege('anon', 'public.submit_application(jsonb, text, int, int)', 'execute');          -- false
--   select has_function_privilege('service_role', 'public.submit_application(jsonb, text, int, int)', 'execute');  -- true
--   select conname from pg_constraint where conname = 'one_person_per_cellphone';                                  -- no rows
-- ------------------------------------------------------------
