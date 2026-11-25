-- ============================================================
-- Pro Mortgage credit-check — the form becomes page 1 of the home loan application
-- (apply AFTER 20261011_notifications.sql and BEFORE pushing the pages: the dashboard asks for the
-- new column by name, and an older cached form keeps working against this file)
-- Idempotent: safe to re-run. Paste into Supabase → SQL Editor → Run. One transaction.
-- ============================================================
-- Why: Kobus Nel, 25 Nov 2026 — the credit-check link must ask exactly what page 1 of Pro Mortgage's
-- Home Loan Application Form asks (personal & contact details, employment details), and the income
-- and expenses section goes (the subscription has no affordability product; the credit check sends
-- zeros for those figures from now on).
-- ============================================================
-- What this does:
--   1. credit_checks.application_details (jsonb): the page-1 answers the record had no column for.
--      Names, ID, contact, address, marital status and occupational status keep their own columns.
--   2. clean_application_details(): only the keys the form sends, text only, trimmed, at most 200
--      characters each, empty answers dropped. A crafted payload cannot store anything else.
--   3. submit_application(): as in 20261005, plus the new column. A form page cached from before
--      this change sends no details and still works.
--   4. notification_candidates() also returns id_type (a passport holder may now complete the form).
-- ============================================================

begin;

alter table public.credit_checks add column if not exists application_details jsonb;

create or replace function public.clean_application_details(d jsonb)
returns jsonb
language sql immutable set search_path = public, pg_temp
as $$
  select case when jsonb_typeof(d) = 'object' then (
    select jsonb_object_agg(e.key, left(btrim(e.value #>> '{}'), 200))
      from jsonb_each(d) e
     where jsonb_typeof(e.value) = 'string'
       and btrim(e.value #>> '{}') <> ''
       and e.key = any (array[
    'gender', 'residencyStatus', 'countryOfMarriage', 'residentialStatus', 'occupiedSince',
    'country', 'nationality', 'countryOfBirth', 'cityOfBirth', 'ethnicGroup',
    'homeLanguage', 'taxOutsideRsa', 'foreignTaxNumber', 'sarsTaxNumber', 'firstTimeBuyer',
    'tertiaryQualification', 'qualificationLevel', 'publicOfficial', 'occupation', 'employmentStartDate',
    'employerName', 'employerLandline', 'employerStreet', 'employerSuburb', 'employerCity',
    'employerPostalCode', 'employerProvince', 'employerCountry', 'prevEmployedYears', 'prevEmployedMonths',
    'previousEmployer', 'occupationalLevel', 'sourceOfIncome', 'salaryFrequency'])
  ) end
$$;
revoke all on function public.clean_application_details(jsonb) from public, anon, authenticated;
grant execute on function public.clean_application_details(jsonb) to service_role;

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
    application_details,
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
    public.clean_application_details(payload->'details'),
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

-- ------------------------------------------------------------
-- 4. Notifications know a passport application from an SA ID one (its email says "no credit check
--    is possible", not "verify the identity by hand"). The result gains a column, so the function
--    is dropped and made again; mm-maintenance reads it by name and works before and after.
-- ------------------------------------------------------------
drop function if exists public.notification_candidates();
create or replace function public.notification_candidates()
returns table (ref text, status text, id_type text, has_id_copy boolean, id_copy_source text,
               recipient_ids uuid[], recipient_emails text[], log jsonb)
language sql stable security definer set search_path = public, pg_temp
as $$
  with usable as (            -- a login an email may go to
    select s.user_id, s.role, u.email
      from staff_members s join auth.users u on u.id = s.user_id
     where s.active and u.email is not null and u.deleted_at is null
       and (u.banned_until is null or u.banned_until < now())
  ), admins as (
    select array_agg(user_id order by email) as ids, array_agg(email order by email) as emails
      from usable where role = 'admin'
  )
  select c.ref, c.status, c.id_type, c.id_document_path is not null, c.id_document_source,
         case when o.user_id is not null then array[o.user_id] else a.ids end,
         case when o.user_id is not null then array[o.email::text] else a.emails::text[] end,
         coalesce((select jsonb_agg(jsonb_build_object('kind', l.kind, 'first_seen_at', l.first_seen_at, 'sent_at', l.sent_at))
                     from notification_log l where l.ref = c.ref), '[]'::jsonb)
    from credit_checks c
    left join usable o on o.user_id = c.consultant_id
    cross join admins a
   where c.status in ('consent_registered', 'idv_waived', 'idv_passed', 'manual_verified',
                      'idv_failed', 'idv_unavailable', 'manual_required', 'config_error')
     and c.created_at > now() - interval '30 days'
   order by c.created_at
$$;
revoke all on function public.notification_candidates() from public, anon, authenticated;
grant execute on function public.notification_candidates() to service_role;

commit;

-- ------------------------------------------------------------
-- Verify (run separately, AFTER the block above):
--   select column_name from information_schema.columns
--    where table_name = 'credit_checks' and column_name = 'application_details';          -- one row
--   select public.clean_application_details('{"gender":"Male","hack":"x","country":"  "}');   -- {"gender": "Male"}
-- ------------------------------------------------------------
