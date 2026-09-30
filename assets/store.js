/* Pro Mortgage credit-check tool — data layer.
   Dual mode, one async API:
     LIVE — Supabase (config.js filled in). The public form calls two RPCs
            (submit_credit_check, confirm_consent) and the mm-client Edge Function
            (consent wording, consent registration, identity questions). Staff read
            the table after Supabase Auth login and act through the mm-staff Edge
            Function — they cannot change a record's status directly (BUILD-PLAN D10).
     DEMO — localStorage in this browser, no login (config.js blank, or ?demo=1 on
            localhost / 127.0.0.1 only — never on the public site, where a shared demo link
            would otherwise keep a real applicant's details in this browser instead of
            sending them). Simulates every stage, including a sample credit report.
   Contract used by index.html and admin.html — see BUILD-PLAN.md §2. */
(function () {
  'use strict';

  var KEY = 'pm_credit_checks_v1';
  var PROFILE_KEY = 'pm_demo_profile_v1';
  var cfg = window.PM_CONFIG || {};
  var params = new URLSearchParams(window.location.search);
  var host = (window.location && window.location.hostname) || '';
  var localHost = host === 'localhost' || host === '127.0.0.1';
  var forceDemo = localHost && params.get('demo') === '1';

  /* ---------- a consultant's personal link: index.html?c=<code> ----------
     The code is not a secret (it only says whose client this is). Kept for the tab's session so
     it survives a reload; a code that is present but malformed is ignored rather than replaced by
     an older one. Same alphabet as the server (new_link_code / _shared/access.ts). */
  var LINK_CODE_RE = /^[a-hj-km-np-z2-9]{8}$/;
  function validLinkCode(v) { return typeof v === 'string' && LINK_CODE_RE.test(v); }
  var consultantCode = (function () {
    var given = params.get('c');
    if (given !== null) {
      var v = String(given).trim().toLowerCase();
      if (!validLinkCode(v)) return null;
      try { sessionStorage.setItem('pm_consultant', v); } catch (e) { /* private mode */ }
      return v;
    }
    try { var kept = sessionStorage.getItem('pm_consultant'); return validLinkCode(kept) ? kept : null; } catch (e) { return null; }
  })();
  var live = !forceDemo && !!(cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY);
  var sb = null;
  var mode = 'demo';

  if (live) {
    if (window.supabase && window.supabase.createClient) {
      sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
      mode = 'live';
    } else {
      mode = 'error'; // configured for live but the client library failed to load
    }
  }

  /* Demo-only: which IDV mode to simulate (?idv=required). A leftover 'optional' fails safe to
     'required', exactly like the server (states.ts idvModeFrom). */
  var DEMO_IDV = (function () {
    var v = params.get('idv') || cfg.DEMO_IDV_MODE || 'off';
    return v === 'optional' || v === 'required' ? 'required' : 'off';
  })();

  /* Demo-only: which role to simulate. ?role=consultant | none (a login that is not active);
     default administrator. ?roles=off simulates the system before migration 20260930. */
  var DEMO_ROLE = params.get('role') === 'consultant' ? 'consultant' : params.get('role') === 'none' ? 'none' : 'admin';
  var DEMO_ROLES_ON = params.get('roles') !== 'off';
  var DEMO_ME = 'demo-me';
  var STAFF_KEY = 'pm_demo_staff_v1';
  function demoStaff() {
    var list = null;
    try { list = JSON.parse(localStorage.getItem(STAFF_KEY)); } catch (e) { list = null; }
    if (!Array.isArray(list)) {
      list = [
        { userId: DEMO_ME, email: 'you@example.com', fullName: 'Demo User', role: 'admin', active: true, linkCode: 'demx22zz' },
        { userId: 'demo-c1', email: 'thandi@example.com', fullName: 'Thandi Mokoena', role: 'consultant', active: true, linkCode: 'thand2zz' },
        { userId: 'demo-c2', email: 'pieter@example.com', fullName: 'Pieter Botha', role: 'consultant', active: false, linkCode: 'pjb234zz' },
        { userId: 'demo-new', email: 'new.login@example.com', fullName: '', role: null, active: false, linkCode: null }
      ];
    }
    list.forEach(function (m) { if (m.userId === DEMO_ME) { m.role = DEMO_ROLE; m.isMe = true; } });
    return list;
  }
  function saveDemoStaff(list) { try { localStorage.setItem(STAFF_KEY, JSON.stringify(list)); } catch (e) { /* private mode */ } }
  function demoMember(userId) { return demoStaff().filter(function (m) { return m.userId === userId; })[0] || null; }
  function demoCanSee(rec) {
    if (!DEMO_ROLES_ON) return true;
    return DEMO_ROLE === 'admin' || (DEMO_ROLE === 'consultant' && !!rec && rec.consultantId === DEMO_ME);
  }

  /* Demo copy of _shared/manual.ts ATTESTATION (parity-tested). In live mode the page shows the
     wording mm-staff returns from 'config' — the text the server stores. */
  var ATTESTATION = {
    version: 'experian-manual-2026-09-28',
    text: 'I hereby confirm that I have read and understood the Experian Terms and conditions and that I have ' +
      'verified the customer\'s identity by validating their identity documents / driver\'s licence and uploaded ' +
      'it to the system. I also presented/read out the Customer Consent for their consideration and acceptance ' +
      'before requesting their credit information via the Experian System.'
  };
  var ID_DOC_TYPES = ['application/pdf', 'image/jpeg', 'image/png'];
  var ID_DOC_MAX_BYTES = 10 * 1024 * 1024;

  var BROAD_CONSENT_ID = '818BB417-0963-4DFF-B7E3-09C66F6D0AF9';
  var MAX_IDV_ROUNDS = 2;
  /* Server timings mirrored by the demo (mm-staff / mm-client stale-state recovery). */
  var STALE_IN_FLIGHT_MS = 5 * 60 * 1000;     // a check still "running" after this was killed mid-call
  var IDV_ANSWER_WINDOW_MS = 6 * 60 * 1000;   // the client's 5:00 countdown plus a minute of slack
  var PERSON_IDV_LIMIT = 2;                   // identity-question rounds per ID number per 24 hours (MortgageMAX's production cooldown)

  /* The register list needs only these columns. The full record (credit report, affordability,
     identity questions, MortgageMAX read-back) is fetched by get(ref) when a record is opened —
     that is where the report view is logged — so opening the register does not pull every
     client's credit report into the browser. fromRow() tolerates the missing columns. */
  var LIST_COLUMNS = 'ref, created_at, status, first_names, surname, id_type, id_number, ' +
    'passport_number, gross_income, report_summary, consent_confirmed_at, idv_started_at, ' +
    'check_started_at, report_ready_at, pdf_status';
  /* Everything a staff member may see on one record — never otp_hash (bug-hunt #12/#29). */
  var DETAIL_COLUMNS = 'id, ref, created_at, status, first_names, surname, id_type, id_number, ' +
    'passport_number, date_of_birth, email, cell, home_phone, work_phone, street, suburb, city, ' +
    'province, postal_code, employment_status, marital_status, referral, gross_income, ' +
    'total_deductions, monthly_expenses, housing_payment, consent_confirmed_at, consent_ua, ' +
    'otp_expires, otp_attempts, audit, mm_person_id, consents_presented, consent_registered_at, ' +
    'mm_consents_snapshot, mm_consents_synced_at, consent_withdrawn_at, idv_attempts, ' +
    'idv_started_at, idv_questions, idv_result, idv_passed_at, verification_success_code, ' +
    'manual_verified_at, manual_verification_id, ' +
    'check_started_at, check_request_id, check_attempt, check_requested_by, check_error_code, ' +
    'check_error_text, group_id, bureau_enquiry_id, report_json, report_summary, ' +
    'affordability_json, report_ready_at, pdf_status, pdf_attempts, report_pdf_path, mm_env';

  /* Ownership columns (migration 20260930). Until it is applied the columns do not exist and the
     database answers 42703: read without them from then on, so this page works either side of it. */
  var ROLE_COLUMNS = ', consultant_id, assigned_at';
  var roleColumns = true;
  var rolesConfirmed = false; /* the server has said roles are installed: the columns must exist */
  function selectChecks(columns, build) {
    function run(withRoles) { return build(sb.from('credit_checks').select(columns + (withRoles ? ROLE_COLUMNS : ''))); }
    return run(roleColumns).then(function (res) {
      /* Only for OUR two columns, and never once roles are confirmed: then a missing column is a
         real fault, and reading without ownership would show every record as unassigned. */
      var ours = res.error && res.error.code === '42703' && /consultant_id|assigned_at/.test(String(res.error.message || ''));
      if (ours && roleColumns && !rolesConfirmed) { roleColumns = false; return run(false); }
      return res;
    });
  }

  /* ---------- errors ---------- */
  function mkErr(e) {
    var err = new Error((e && e.message) || 'Something went wrong');
    err.code = (e && e.code) || 'server_error';
    if (e && e.vendorCode) err.vendorCode = e.vendorCode;
    if (e && e.traceId) err.traceId = e.traceId;
    return err;
  }

  /* Edge Function call → the envelope's data, or a thrown Error with .code (BUILD-PLAN Step 4). */
  function invoke(name, body) {
    return sb.functions.invoke(name, { body: body }).then(function (res) {
      if (!res.error) {
        var d = res.data;
        if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { d = null; } }
        if (d && d.ok) return d.data;
        throw mkErr((d && d.error) || { code: 'server_error', message: 'Unexpected response' });
      }
      var ctx = res.error.context;
      if (ctx && typeof ctx.json === 'function') {
        return ctx.json().catch(function () { return null; }).then(function (j) {
          throw mkErr((j && j.error) || { code: 'network', message: 'Could not reach the server' });
        });
      }
      throw mkErr({ code: 'network', message: 'Could not reach the server' });
    });
  }

  /* ---------- one-time IDV session token (issued by confirm_consent) ---------- */
  function tokenKey(ref) { return 'pm_idv_' + ref; }
  function setToken(ref, t) { try { sessionStorage.setItem(tokenKey(ref), t); } catch (e) { /* private mode */ } memTokens[ref] = t; }
  function getToken(ref) {
    if (memTokens[ref]) return memTokens[ref];
    try { return sessionStorage.getItem(tokenKey(ref)); } catch (e) { return null; }
  }
  var memTokens = {};

  /* ---------- resend token for the SMS code (issued by mm-client submit) ---------- */
  var OTP_COOLDOWN_S = 60;   /* mirrors _shared/sms.ts — the server enforces both */
  var OTP_MAX_SENDS = 3;
  var memOtpSessions = {};
  function otpKey(ref) { return 'pm_otp_' + ref; }
  function setOtpSession(ref, t) { try { sessionStorage.setItem(otpKey(ref), t); } catch (e) { /* private mode */ } memOtpSessions[ref] = t; }
  function getOtpSession(ref) {
    if (memOtpSessions[ref]) return memOtpSessions[ref];
    try { return sessionStorage.getItem(otpKey(ref)); } catch (e) { return null; }
  }

  /* ---------- demo-mode storage ---------- */
  function readAll() {
    try { return JSON.parse(localStorage.getItem(KEY)) || []; }
    catch (e) { return []; }
  }
  function writeAll(list) { localStorage.setItem(KEY, JSON.stringify(list)); }
  function makeRef() {
    var t = Date.now().toString(36).toUpperCase().slice(-4);
    var r = Math.random().toString(36).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3);
    return 'PM-' + t + r;
  }
  function makeOtp() { return String(Math.floor(100000 + Math.random() * 900000)); }
  function demoFind(ref) { return readAll().find(function (r) { return r.ref === ref; }) || null; }
  function demoUpdate(ref, patch, auditEvent) {
    var list = readAll();
    var i = list.findIndex(function (r) { return r.ref === ref; });
    if (i === -1) return null;
    Object.assign(list[i], patch);
    if (auditEvent) list[i].audit.push({ at: Date.now(), event: auditEvent });
    writeAll(list);
    return list[i];
  }
  function demoFail(code, message) { return Promise.reject(mkErr({ code: code, message: message })); }
  /* The person a demo record belongs to (the server's mm_person_id). */
  function personKey(r) {
    return r.idType === 'passport' ? 'P:' + String(r.passportNumber || '') : 'I:' + String(r.idNumber || '');
  }
  /* Mirrors the server's stale-state recovery, which runs before every action on a record:
     a check left running past the stale window → check_failed; identity questions left open past
     the answer window → idv_failed {expired}. Returns the (possibly updated) record. */
  function demoRecover(ref) {
    var rec = demoFind(ref);
    if (!rec) return null;
    var now = Date.now();
    if (rec.status === 'check_in_flight' && rec.checkStartedAt && now - rec.checkStartedAt > STALE_IN_FLIGHT_MS) {
      return demoUpdate(ref, {
        status: 'check_failed', checkErrorCode: 'stale_in_flight',
        checkErrorText: 'The previous check did not complete. MortgageMAX may still have processed it — check before retrying.'
      }, 'Previous credit check did not complete (recovered automatically)');
    }
    if (rec.status === 'idv_in_progress' && (!rec.idvStartedAt || now - rec.idvStartedAt > IDV_ANSWER_WINDOW_MS)) {
      return demoUpdate(ref, { status: 'idv_failed', idvResult: { expired: true } },
        'Identity questions expired before they were answered (recovered automatically)');
    }
    return rec;
  }

  /* ---------- live-mode row mapping (snake_case -> camelCase) ----------
     Rows from all() carry only LIST_COLUMNS; every other field falls back to its empty value. */
  function ts(v) { return v ? Date.parse(v) : null; }
  function fromRow(r) {
    return {
      ref: r.ref,
      createdAt: Date.parse(r.created_at),
      status: r.status,
      firstNames: r.first_names, surname: r.surname,
      idType: r.id_type, idNumber: r.id_number || '',
      passportNumber: r.passport_number || '', dateOfBirth: r.date_of_birth || '',
      email: r.email, cell: r.cell,
      homePhone: r.home_phone || '', workPhone: r.work_phone || '',
      street: r.street, suburb: r.suburb, city: r.city,
      province: r.province, postalCode: r.postal_code,
      employmentStatus: r.employment_status, maritalStatus: r.marital_status,
      referral: r.referral || '',
      grossIncome: Number(r.gross_income) || 0,
      totalDeductions: Number(r.total_deductions) || 0,
      monthlyExpenses: Number(r.monthly_expenses) || 0,
      housingPayment: Number(r.housing_payment) || 0,
      consentConfirmedAt: ts(r.consent_confirmed_at),
      consentUA: r.consent_ua || '',
      audit: r.audit || [],
      /* MortgageMax integration */
      consentsPresented: r.consents_presented || [],
      consentRegisteredAt: ts(r.consent_registered_at),
      mmConsentsSnapshot: r.mm_consents_snapshot || null,
      mmConsentsSyncedAt: ts(r.mm_consents_synced_at),
      consentWithdrawnAt: ts(r.consent_withdrawn_at),
      idvAttempts: r.idv_attempts || 0,
      idvStartedAt: ts(r.idv_started_at),
      idvQuestionCount: Array.isArray(r.idv_questions) ? r.idv_questions.length : 0,
      idvResult: r.idv_result || null,
      consultantId: r.consultant_id || null,
      assignedAt: ts(r.assigned_at),
      idvPassedAt: ts(r.idv_passed_at),
      manualVerifiedAt: ts(r.manual_verified_at),
      manualVerificationId: r.manual_verification_id || null,
      checkStartedAt: ts(r.check_started_at),
      checkAttempt: r.check_attempt || 0,
      checkErrorCode: r.check_error_code || '',
      checkErrorText: r.check_error_text || '',
      groupId: r.group_id || '',
      bureauEnquiryId: r.bureau_enquiry_id || '',
      reportJson: r.report_json || null,
      reportSummary: r.report_summary || null,
      affordability: r.affordability_json || null,
      reportReadyAt: ts(r.report_ready_at),
      pdfStatus: r.pdf_status || null,
      pdfAttempts: r.pdf_attempts || 0,
      reportPdfPath: r.report_pdf_path || '',
      mmEnv: r.mm_env || ''
    };
  }
  function auditEntry(event) { return { at: Date.now(), event: event }; }

  /* ---------- SA ID helpers ---------- */
  function luhnTotal(digits) {
    var sum = 0;
    for (var i = 0; i < digits.length; i++) {
      var d = Number(digits[digits.length - 1 - i]);
      if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
      sum += d;
    }
    return sum;
  }
  function validSaId(id) {
    if (!/^\d{13}$/.test(id)) return false;
    var m = Number(id.slice(2, 4)), d = Number(id.slice(4, 6));
    if (m < 1 || m > 12 || d < 1 || d > 31) return false;
    return luhnTotal(id) % 10 === 0;
  }
  function saIdCheckDigit(first12) {
    var t = luhnTotal(first12 + '0');
    return String((10 - (t % 10)) % 10);
  }
  function saIdDerive(id) {
    if (!validSaId(id)) return null;
    var yy = Number(id.slice(0, 2));
    var nowYY = new Date().getFullYear() % 100;
    var year = yy <= nowYY ? 2000 + yy : 1900 + yy;
    return {
      dob: year + '-' + id.slice(2, 4) + '-' + id.slice(4, 6),
      gender: Number(id.slice(6, 10)) >= 5000 ? 'Male' : 'Female',
      citizen: id[10] === '0' ? 'SA citizen' : 'Permanent resident'
    };
  }

  /* ---------- status machine (mirrors the DB CHECK and BUILD-PLAN §2) ----------
     group: which admin tile/filter bucket a status belongs to. */
  var STATUS = {
    awaiting_otp:       { label: 'Awaiting SMS code',          chip: 'chip-awaiting',  group: 'awaiting' },
    consent_confirmed:  { label: 'Consent confirmed — not yet registered', chip: 'chip-attention', group: 'attention' },
    consent_registered: { label: 'Consent registered',         chip: 'chip-confirmed', group: 'ready' },
    idv_in_progress:    { label: 'Identity check in progress', chip: 'chip-awaiting',  group: 'awaiting' },
    idv_passed:         { label: 'Identity verified',          chip: 'chip-confirmed', group: 'ready' },
    idv_waived:         { label: 'Ready for credit check',     chip: 'chip-confirmed', group: 'ready' },
    idv_failed:         { label: 'Identity check failed',      chip: 'chip-attention', group: 'attention' },
    idv_unavailable:    { label: 'Identity check unavailable', chip: 'chip-attention', group: 'attention' },
    manual_verified:    { label: 'Identity verified manually', chip: 'chip-confirmed', group: 'ready' },
    check_in_flight:    { label: 'Credit check running',       chip: 'chip-requested', group: 'awaiting' },
    report_ready:       { label: 'Report ready',               chip: 'chip-ready',     group: 'reports' },
    check_failed:       { label: 'Credit check failed',        chip: 'chip-failed',    group: 'attention' },
    manual_required:    { label: 'Manual handling',            chip: 'chip-attention', group: 'attention' },
    config_error:       { label: 'System issue',               chip: 'chip-failed',    group: 'attention' },
    consent_withdrawn:  { label: 'Consent withdrawn',          chip: 'chip-muted',     group: 'closed' },
    expired:            { label: 'Expired',                    chip: 'chip-muted',     group: 'closed' },
    report_requested:   { label: 'Report requested (legacy)',  chip: 'chip-requested', group: 'awaiting' }
  };

  /* ---------- what staff see: five buckets (list, filter, tiles); the detail is in View ---------- */
  var BUCKETS = [
    { key: 'waiting',   label: 'Waiting on client', chip: 'chip-awaiting' },
    { key: 'ready',     label: 'Ready to run',      chip: 'chip-confirmed' },
    { key: 'report',    label: 'Report ready',      chip: 'chip-ready' },
    { key: 'attention', label: 'Needs attention',   chip: 'chip-attention' },
    { key: 'closed',    label: 'Closed',            chip: 'chip-muted' }
  ];
  /* Exactly one bucket per record. Order matters: a stalled record or one a consultant must decide
     on is "Needs attention" even when the identity setting would let it run. */
  var ATTENTION = ['consent_confirmed', 'idv_failed', 'idv_unavailable', 'check_failed',
                   'manual_required', 'config_error', 'report_requested'];
  function bucketOf(status, idvMode, stalled) {
    if (stalled || ATTENTION.indexOf(status) !== -1) return 'attention';
    if (status === 'report_ready') return 'report';
    if (status === 'consent_withdrawn' || status === 'expired') return 'closed';
    if (status === 'check_in_flight' || allowedFrom(idvMode).indexOf(status) !== -1) return 'ready';
    return 'waiting'; /* awaiting_otp, idv_in_progress, consent_registered while identity questions are due */
  }
  function bucketInfo(key) {
    for (var i = 0; i < BUCKETS.length; i++) if (BUCKETS[i].key === key) return BUCKETS[i];
    return { key: key, label: 'Unknown', chip: 'chip-neutral' };
  }
  /* One plain sentence for View: what is happening, and what (if anything) staff should do. */
  var HINTS = {
    awaiting_otp: 'The client submitted the form but hasn’t entered their SMS code yet. Nothing to do unless they ask for help — it expires after 24 hours.',
    consent_confirmed: 'The client confirmed consent, but it isn’t registered with MortgageMAX yet. Use “Retry consent registration” below.',
    idv_in_progress: 'The client is answering the identity questions (5-minute limit). Nothing to do.',
    idv_passed: 'The client passed the identity questions. You can run the credit check.',
    idv_waived: 'Consent is registered and identity questions aren’t required. You can run the credit check.',
    idv_failed: 'The client didn’t pass the identity questions. To go ahead, verify their identity manually below: upload a copy of their ID and confirm the Experian statement.',
    idv_unavailable: 'The credit bureau couldn’t produce identity questions for this ID number. To go ahead, verify the client’s identity manually below: upload a copy of their ID and confirm the Experian statement.',
    manual_verified: 'The client’s identity was verified manually (ID copy + Experian statement, shown below). You can run the credit check.',
    check_in_flight: 'The credit check is running. This usually takes under a minute.',
    report_ready: 'The credit report is ready — see below.',
    check_failed: 'The credit check didn’t complete. See the error below, then run it again.',
    manual_required: 'This needs a person. The history below says why (for example an earlier withdrawal of consent, a passport, or too many identity attempts).',
    config_error: 'MortgageMAX rejected our system credentials — not the client’s fault. Contact ARRABON; once fixed, use “Clear system error”.',
    consent_withdrawn: 'The client withdrew consent. No credit check may be run.',
    expired: 'The client didn’t finish in time. Nothing to do — they can submit a new form.',
    report_requested: 'A record from the old August form. Handle it manually.'
  };
  function hintFor(status, bucket, stalled) {
    if (stalled) return 'This has been stuck for a while. Opening it asked the system to recover it — it updates in a moment.';
    if (status === 'consent_registered') {
      return bucket === 'ready'
        ? 'Consent is registered with MortgageMAX. You can run the credit check.'
        : 'Consent is registered with MortgageMAX. The client still has to answer the identity questions.';
    }
    return HINTS[status] || '';
  }

  /* Which statuses may start a credit check — identical to mm-staff allowedFrom(). */
  function allowedFrom(idvMode) {
    var retry = ['check_failed'];
    if (idvMode === 'required') return ['idv_passed', 'manual_verified'].concat(retry);
    return ['consent_registered', 'idv_waived', 'idv_passed', 'manual_verified'].concat(retry);
  }

  /* May staff re-issue the identity-check link? — identical to _shared/states.ts idvLinkCheck(). */
  var IDV_LINK_TTL_MS = 24 * 60 * 60 * 1000;
  function idvLinkCheck(rec, idvMode) {
    if (idvMode !== 'required') return { ok: false, reason: 'idv_off' };
    if (rec.idType !== 'said') return { ok: false, reason: 'not_sa_id' };
    if (rec.consentWithdrawnAt) return { ok: false, reason: 'withdrawn' };
    if (rec.status === 'consent_registered') return { ok: true };
    if (rec.status === 'idv_failed' && Number(rec.idvAttempts || 0) < MAX_IDV_ROUNDS) return { ok: true };
    return { ok: false, reason: 'status_' + String(rec.status || '') };
  }
  function randomHex(bytes) {
    var a = new Uint8Array(bytes);
    crypto.getRandomValues(a);
    return Array.prototype.map.call(a, function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  }

  /* May this record be verified manually? — identical to _shared/manual.ts manualVerifyCheck(). */
  var MANUAL_FROM = ['consent_registered', 'idv_failed', 'idv_unavailable', 'idv_waived'];
  function manualVerifyCheck(rec) {
    if (rec.idType !== 'said') return { ok: false, reason: 'not_sa_id' };
    if (rec.consentWithdrawnAt) return { ok: false, reason: 'withdrawn' };
    if (MANUAL_FROM.indexOf(rec.status) !== -1) return { ok: true };
    if (rec.status === 'manual_required' && rec.consentRegisteredAt) return { ok: true };
    return { ok: false, reason: 'status_' + rec.status };
  }

  /* ---------- consent wording ---------- */
  function normaliseForHash(s) { return String(s).replace(/\r\n?/g, '\n').trim(); }
  function sha256Hex(s) {
    if (!window.crypto || !crypto.subtle) return Promise.resolve('');
    return crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)).then(function (buf) {
      return Array.prototype.map.call(new Uint8Array(buf), function (b) {
        return b.toString(16).padStart(2, '0');
      }).join('');
    });
  }
  function demoConsentTypes() {
    return fetch('assets/fixtures/consent-types.json').then(function (r) {
      if (!r.ok) throw mkErr({ code: 'server_error', message: 'Consent wording is unavailable' });
      return r.json();
    }).then(function (all) {
      var t = all.find(function (x) { return String(x.id).toLowerCase() === BROAD_CONSENT_ID.toLowerCase(); });
      if (!t) throw mkErr({ code: 'server_error', message: 'Consent wording is unavailable' });
      var decl = String(t.declaration).split('${MOBusinessGroup}').join('MortgageMAX');
      return sha256Hex(normaliseForHash(decl)).then(function (h) {
        return [{ id: t.id, name: t.name, version: t.version, declaration: decl, isHtml: /<\s*(p|br|a|sup|strong)\b/i.test(decl), hash: h }];
      });
    });
  }

  /* Demo registration: mirrors _shared/register.ts — every outcome the server turns into
     manual handling (not an error) is manual handling here too, so neither the client nor a
     staff retry gets stuck on a record that can never register. */
  function demoRegister(ref) {
    var rec = demoFind(ref);
    if (!rec || rec.status !== 'consent_confirmed') return demoFail('invalid_state', 'Consent cannot be registered now');
    function manual(why, reason) {
      demoUpdate(ref, { status: 'manual_required' }, why);
      return { status: 'manual_required', idvMode: DEMO_IDV, reason: reason || 'manual' };
    }
    if (rec.idType === 'passport' && !PMStore.allowPassport) {
      return Promise.resolve(manual('Passport applicant — routed to consultant (automated check supports SA ID numbers only)', 'passport'));
    }
    if (rec.idType !== 'passport' && !validSaId(String(rec.idNumber || ''))) {
      return Promise.resolve(manual('ID number could not be validated', 'invalid_id'));
    }
    var key = personKey(rec);
    var withdrawnElsewhere = readAll().some(function (o) {
      return o.ref !== ref && o.status === 'consent_withdrawn' && personKey(o) === key;
    });
    if (withdrawnElsewhere) {
      return Promise.resolve(manual('Previous withdrawal on record — consultant must confirm with the person before re-registering', 'prior_withdrawal'));
    }
    var presented = Array.isArray(rec.consentsPresented) ? rec.consentsPresented : [];
    return demoConsentTypes().then(function (types) {
      var now = demoFind(ref);
      if (!now || now.status !== 'consent_confirmed') throw mkErr({ code: 'invalid_state', message: 'registration_in_progress' });
      var shown = presented.length > 0 && types.every(function (t) {
        return presented.some(function (c) {
          return c && String(c.id).toLowerCase() === String(t.id).toLowerCase() &&
            String(c.version) === String(t.version) && c.hash === t.hash;
        });
      });
      if (!shown) return manual('Consent wording changed or was not shown — client must re-consent', 'consent_stale');
      var next = DEMO_IDV === 'off' ? 'idv_waived' : 'consent_registered';
      demoUpdate(ref, { status: next, consentRegisteredAt: Date.now() },
        DEMO_IDV === 'off'
          ? 'Consent registered with MortgageMax; identity questions waived by configuration'
          : 'Consent registered with MortgageMax');
      return { status: next, idvMode: DEMO_IDV };
    });
  }

  /* ---------- demo IDV questions + sample report (schema-faithful, synthetic) ---------- */
  var DEMO_QUESTIONS = [
    { questionNumber: '1', questionText: 'Which of these institutions do you hold a vehicle finance account with?',
      possibleAnswers: [{ value: '1', label: 'WesBank' }, { value: '2', label: 'MFC' }, { value: '3', label: 'Toyota Financial Services' }, { value: '4', label: 'None of the above' }] },
    { questionNumber: '2', questionText: 'In which suburb have you previously lived?',
      possibleAnswers: [{ value: '1', label: 'Brooklyn' }, { value: '2', label: 'Menlyn' }, { value: '3', label: 'Centurion' }, { value: '4', label: 'None of the above' }] },
    { questionNumber: '3', questionText: 'What is the approximate monthly instalment on your home loan?',
      possibleAnswers: [{ value: '1', label: 'R0 – R5,000' }, { value: '2', label: 'R5,001 – R10,000' }, { value: '3', label: 'R10,001 – R15,000' }, { value: '4', label: 'I do not have a home loan' }] }
  ];
  function demoReport() {
    return {
      summary: {
        score: 642, riskType: 'Medium', riskColour: 'rgb(255, 191, 0)', rag: 'Amber', thinFile: 'no',
        declineReasons: [],
        flags: { deceased: 'no', fraud: 'no', dispute: 'no', sequestration: 'no', debtReview: 'no', debtReviewRequested: 'no', debtReviewGranted: 'no' },
        counts: { judgements: 0, adverse: 0, publicDefaults: 0, debtRestructures: 0, notices: 0, collections: 0 },
        standing: { judgements: 'no', adverse: 'no', notices: 'no', judgementsLast5Years: 0, adverseJudgementsLastYear: 0, monthsInArrears: 0, overdueBalances: 0, creditStatus: null, creditClassification: 'Acceptable' },
        affordability: { present: true, success: true, amount: 1450000, error: null },
        enquiryId: 'DEMO-ENQ-0001'
      },
      json: {
        cC_ENQUIRY_ID: 'DEMO-ENQ-0001', credits: 0, ontrace: false, paymenthist: true,
        cC_RESULTS: {
          enqCC_CompuSCORE: [{ score: '642', risK_TYPE: 'Medium', risK_COLOUR_R: '255', risK_COLOUR_G: '191', risK_COLOUR_B: '0', thiN_FILE_INDICATOR: 'N', scorE_TYPE: 'Compuscore' }],
          enqCC_JUDGEMENTS: [], enqCC_ADVERSE: [], enqCC_PUBLIC_DEFAULTS: [], enqCC_DEBT_RESTRUCT: [],
          enqCC_NOTICES: [], enqCC_COLLECTIONS: [], enqCC_ENQ_COUNTS: [], enqCC_ADDRESS: [], enqCC_EMPLOYER: []
        }
      },
      affordability: { success: true, amount: '1450000', ragIndicator: 'Amber', score: '642' }
    };
  }

  var PMStore = {
    mode: mode,
    STATUS: STATUS,
    allowedFrom: allowedFrom,
    manualVerifyCheck: manualVerifyCheck,
    idvLinkCheck: idvLinkCheck,
    ATTESTATION: ATTESTATION,
    BUCKETS: BUCKETS,
    bucketOf: bucketOf,
    bucketInfo: bucketInfo,
    hintFor: hintFor,
    MAX_IDV_ROUNDS: MAX_IDV_ROUNDS,
    allowPassport: cfg.ALLOW_PASSPORT === true,
    validSaId: validSaId,
    saIdDerive: saIdDerive,
    saIdCheckDigit: saIdCheckDigit,

    /* ===== client form API ===== */

    /* [{id, name, version, declaration, isHtml, hash}] — the wording the form MUST render.
       Echo {id, version, hash} back in submit({consentsPresented}). declaration may be HTML:
       callers must sanitise before inserting it into the page. */
    consentTypes: function () {
      if (mode === 'live') return invoke('mm-client', { action: 'consent-types' }).then(function (d) { return d.types || []; });
      return demoConsentTypes();
    },

    /* The consultant whose personal link the client opened: → {name} (first name) or {name: null}
       for no link, an unknown code or a deactivated consultant. Never throws — the form must work
       without it, and the application is then handed out by an administrator. */
    consultantCode: consultantCode,
    validLinkCode: validLinkCode,
    consultant: function () {
      if (!consultantCode) return Promise.resolve({ name: null });
      if (mode !== 'live') {
        var dm = demoStaff().filter(function (m) { return m.linkCode === consultantCode && m.active && m.role; })[0];
        return Promise.resolve({ name: dm ? String(dm.fullName).split(' ')[0] : null });
      }
      return invoke('mm-client', { action: 'consultant', code: consultantCode })
        .then(function (d) { return { name: d && typeof d.name === 'string' && d.name ? d.name : null }; },
          function () { return { name: null }; });
    },

    /* returns {ref, demo_otp, sms: {sent, reason?, uncertain, retryAfter, sendsLeft, canResend}}.
       demo_otp is null when the code really went by SMS (SMS_MODE=live). Refusals throw an Error
       whose message is the code (invalid_id_number, invalid_cell, too_many_submissions, …). */
    submit: function (data) {
      if (mode === 'live') {
        var body = { action: 'submit', payload: data };
        if (consultantCode) body.consultant_code = consultantCode;
        return invoke('mm-client', body).then(function (d) {
          if (d.otp_session) setOtpSession(d.ref, d.otp_session);
          return d;
        });
      }
      var rec = Object.assign({}, data, {
        ref: makeRef(),
        createdAt: Date.now(),
        status: 'awaiting_otp',
        otp: makeOtp(),
        otpExpires: Date.now() + 10 * 60 * 1000,
        otpAttempts: 0,
        otpSends: 1,
        otpSentAt: Date.now(),
        idvAttempts: 0,
        audit: [auditEntry('Form submitted by client'), auditEntry('Consent code sent by SMS [demo mode]')]
      });
      var via = consultantCode ? demoStaff().filter(function (m) { return m.linkCode === consultantCode && m.active && m.role; })[0] : null;
      if (via) {
        rec.consultantId = via.userId;
        rec.assignedAt = Date.now();
        rec.audit.push(auditEntry('Received through the personal link of ' + via.fullName));
      }
      var list = readAll();
      list.push(rec);
      writeAll(list);
      return Promise.resolve({
        ref: rec.ref, demo_otp: rec.otp,
        sms: { sent: true, uncertain: false, retryAfter: OTP_COOLDOWN_S, sendsLeft: OTP_MAX_SENDS - 1, canResend: true }
      });
    },

    /* Ask for a new SMS code (the old one stops working).
       → {sent, reason?: cooldown|too_many_sends|send_failed|cell_limit|daily_limit|invalid_state|unavailable,
          uncertain, retryAfter (seconds), sendsLeft, demo_otp}. A lost or foreign session throws code 'forbidden'. */
    resendCode: function (ref) {
      if (mode === 'live') {
        var session = getOtpSession(ref);
        if (!session) return Promise.reject(mkErr({ code: 'forbidden', message: 'Invalid or expired session' }));
        return invoke('mm-client', { action: 'resend-otp', ref: ref, otp_session: session });
      }
      var rec = demoFind(ref);
      if (!rec || rec.status !== 'awaiting_otp') return Promise.resolve({ sent: false, reason: 'invalid_state' });
      var wait = Math.ceil(((rec.otpSentAt || 0) + OTP_COOLDOWN_S * 1000 - Date.now()) / 1000);
      if (wait > 0) return Promise.resolve({ sent: false, reason: 'cooldown', retryAfter: wait });
      if ((rec.otpSends || 1) >= OTP_MAX_SENDS) return Promise.resolve({ sent: false, reason: 'too_many_sends' });
      var sends = (rec.otpSends || 1) + 1;
      var code = makeOtp();
      demoUpdate(ref, { otp: code, otpExpires: Date.now() + 10 * 60 * 1000, otpAttempts: 0, otpSends: sends, otpSentAt: Date.now() },
        'Consent code sent by SMS — resend ' + (sends - 1) + ' [demo mode]');
      return Promise.resolve({ sent: true, uncertain: false, retryAfter: OTP_COOLDOWN_S, sendsLeft: OTP_MAX_SENDS - sends, demo_otp: code });
    },

    /* returns {ok, ref} or {ok:false, error: not_found|already_confirmed|expired|mismatch|too_many_attempts}.
       On success the one-time IDV session token is kept in this tab (sessionStorage). */
    confirmConsent: function (ref, otp) {
      if (mode === 'live') {
        return sb.rpc('confirm_consent', { p_ref: ref, p_otp: otp }).then(function (res) {
          if (res.error) throw new Error(res.error.message);
          var d = res.data || {};
          if (d.ok && d.idv_token) setToken(ref, d.idv_token);
          return { ok: !!d.ok, ref: d.ref, error: d.error };
        });
      }
      var rec = demoFind(ref);
      if (!rec) return Promise.resolve({ ok: false, error: 'not_found' });
      if (rec.status !== 'awaiting_otp') return Promise.resolve({ ok: false, error: 'already_confirmed' });
      if ((rec.otpAttempts || 0) >= 5) return Promise.resolve({ ok: false, error: 'too_many_attempts' });
      if (Date.now() > rec.otpExpires) return Promise.resolve({ ok: false, error: 'expired' });
      if (otp !== rec.otp) {
        demoUpdate(ref, { otpAttempts: (rec.otpAttempts || 0) + 1 });
        return Promise.resolve({ ok: false, error: 'mismatch' });
      }
      demoUpdate(ref, { status: 'consent_confirmed', consentConfirmedAt: Date.now(), otp: null },
        'Consent confirmed via SMS one-time PIN');
      setToken(ref, 'demo');
      return Promise.resolve({ ok: true, ref: ref });
    },

    /* After OTP: register consent with MortgageMax.
       → {status: 'idv_waived'|'consent_registered'|'manual_required', idvMode}
       manual_required covers every case a person must sort out (passport, an ID number that fails
       validation, consent wording that changed or was not shown, a previous withdrawal on record).
       Throws Error{code}: forbidden (session expired), invalid_state (registration_in_progress),
       vendor_error, config_error, network. */
    registerConsent: function (ref) {
      var token = getToken(ref);
      if (!token) return demoFail('forbidden', 'Your session has expired');
      if (mode === 'live') return invoke('mm-client', { action: 'register-consent', ref: ref, idv_token: token });
      return demoRegister(ref);
    },

    /* → {skipped:true} when IDV is off; {status:'idv_in_progress', questions:[{questionNumber,
       questionText, possibleAnswers:[{value,label}]}]}; {status:'idv_unavailable'} (the bureau
       answered but had no usable questions); or {status:'manual_required'} (too many rounds for
       this ID number in 24 hours). A transient vendor failure throws Error{code:'vendor_error'}
       and does not use up the round. */
    idvStart: function (ref) {
      var token = getToken(ref);
      if (!token) return demoFail('forbidden', 'Your session has expired');
      if (mode === 'live') return invoke('mm-client', { action: 'idv-start', ref: ref, idv_token: token });
      if (DEMO_IDV === 'off') return Promise.resolve({ skipped: true });
      var rec = demoRecover(ref);
      var retry = rec && rec.status === 'idv_failed' && (rec.idvAttempts || 0) < MAX_IDV_ROUNDS;
      if (!rec || (rec.status !== 'consent_registered' && !retry)) return demoFail('invalid_state', 'Identity check cannot start now');
      var key = personKey(rec);
      var since = Date.now() - 24 * 60 * 60 * 1000;
      var used = readAll().reduce(function (n, o) {
        return personKey(o) === key && o.idvStartedAt && o.idvStartedAt >= since ? n + (o.idvAttempts || 0) : n;
      }, 0);
      if (used >= PERSON_IDV_LIMIT) {
        demoUpdate(ref, { status: 'manual_required' }, 'Too many identity-question rounds for this ID number in 24 hours');
        return Promise.resolve({ status: 'manual_required' });
      }
      var round = (rec.idvAttempts || 0) + 1;
      demoUpdate(ref, { status: 'idv_in_progress', idvAttempts: round, idvStartedAt: Date.now(), idvResult: null },
        'Identity questions issued (round ' + round + ')');
      return Promise.resolve({ status: 'idv_in_progress', questions: DEMO_QUESTIONS });
    },

    /* answers: [{questionNumber, answerNumber}] (answerNumber = the chosen possibleAnswers[].value)
       → {status:'idv_passed'} or {status:'idv_failed', canRetry, reason}
       reason: 'mismatch' (the bureau said no) | 'expired' (the server's answer window passed)
             | 'error' (the bureau could not be reached / did not answer). */
    /* The client's countdown ran out: close the round now so the retry they are owed is available.
       → {status:'idv_failed', canRetry, reason:'expired'} */
    idvExpire: function (ref) {
      var token = getToken(ref);
      if (!token) return demoFail('forbidden', 'Your session has expired');
      if (mode === 'live') return invoke('mm-client', { action: 'idv-expire', ref: ref, idv_token: token });
      var rec = demoFind(ref);
      if (!rec || rec.status !== 'idv_in_progress') return demoFail('invalid_state', 'No identity check in progress');
      demoUpdate(ref, { status: 'idv_failed' }, 'Identity questions expired before they were answered');
      return Promise.resolve({ status: 'idv_failed', canRetry: (rec.idvAttempts || 0) < MAX_IDV_ROUNDS, reason: 'expired' });
    },

    idvAnswer: function (ref, answers) {
      var token = getToken(ref);
      if (!token) return demoFail('forbidden', 'Your session has expired');
      if (mode === 'live') return invoke('mm-client', { action: 'idv-answer', ref: ref, idv_token: token, answers: answers });
      var rec = demoFind(ref);
      if (rec && rec.status === 'idv_in_progress' && (!rec.idvStartedAt || Date.now() - rec.idvStartedAt > IDV_ANSWER_WINDOW_MS)) {
        demoUpdate(ref, { status: 'idv_failed', idvResult: { expired: true } }, 'Identity questions expired before they were answered');
        return Promise.resolve({ status: 'idv_failed', reason: 'expired', canRetry: (rec.idvAttempts || 0) < MAX_IDV_ROUNDS });
      }
      if (!rec || rec.status !== 'idv_in_progress') return demoFail('invalid_state', 'No identity check in progress');
      var allFour = answers.every(function (a) { return a.answerNumber === '4'; });
      if (allFour) {
        demoUpdate(ref, { status: 'idv_failed', idvResult: { success: false } }, 'Identity check not passed');
        return Promise.resolve({ status: 'idv_failed', reason: 'mismatch', canRetry: (rec.idvAttempts || 0) < MAX_IDV_ROUNDS });
      }
      demoUpdate(ref, { status: 'idv_passed', idvPassedAt: Date.now() }, 'Identity verified');
      return Promise.resolve({ status: 'idv_passed' });
    },

    /* demo-mode only: client backs out of the OTP step */
    abandon: function (ref) {
      if (mode !== 'demo') return Promise.resolve();
      writeAll(readAll().filter(function (r) { return r.ref !== ref; }));
      return Promise.resolve();
    },

    /* ===== staff auth (live mode) ===== */

    getSession: function () {
      if (mode !== 'live') return Promise.resolve(null);
      return sb.auth.getSession().then(function (res) { return res.data.session; });
    },
    signIn: function (email, password) {
      return sb.auth.signInWithPassword({ email: email, password: password }).then(function (res) {
        if (res.error) throw new Error(res.error.message);
        return res.data.session;
      });
    },
    signOut: function () { return sb.auth.signOut(); },

    /* ===== admin register API (staff) ===== */

    /* → {mode:'live'|'mock'|'demo', idvMode, env, allowPassport} */
    config: function () {
      if (mode === 'live') return invoke('mm-staff', { action: 'config' });
      if (DEMO_ROLES_ON && DEMO_ROLE === 'none') return demoFail('forbidden', 'account_inactive');
      return Promise.resolve({ mode: 'demo', idvMode: DEMO_IDV, env: 'demo', allowPassport: PMStore.allowPassport,
        attestation: ATTESTATION, idDocument: { maxBytes: ID_DOC_MAX_BYTES, types: ID_DOC_TYPES },
        me: DEMO_ROLES_ON
          ? { userId: DEMO_ME, role: DEMO_ROLE, linkCode: demoMember(DEMO_ME).linkCode, roles: true }
          : { userId: DEMO_ME, role: 'admin', linkCode: null, roles: false } });
    },

    /* The register list: summary columns only (see LIST_COLUMNS). Use get(ref) for a full record. */
    all: function () {
      if (mode === 'live') {
        return selectChecks(LIST_COLUMNS, function (q) { return q.order('created_at', { ascending: false }); })
          .then(function (res) {
            if (res.error) throw new Error(res.error.message);
            return res.data.map(fromRow);
          });
      }
      return Promise.resolve(readAll().filter(demoCanSee).sort(function (a, b) { return b.createdAt - a.createdAt; }));
    },
    get: function (ref) {
      if (mode === 'live') {
        return selectChecks(DETAIL_COLUMNS, function (q) { return q.eq('ref', ref).maybeSingle(); })
          .then(function (res) {
            if (res.error) throw new Error(res.error.message);
            return res.data ? fromRow(res.data) : null;
          });
      }
      var found = demoFind(ref);
      return Promise.resolve(found && demoCanSee(found) ? found : null);
    },

    /* The server reports that roles are installed (config → me.roles): read ownership from now on,
       even if an earlier read on this page went without it. */
    rolesAreOn: function () { rolesConfirmed = true; roleColumns = true; },

    /* ===== roles (migration 20260930): administrators only ===== */

    /* Every login with its role, personal link code and number of clients.
       → [{userId, email, fullName, role|null, active, linkCode, clients, isMe}] */
    staffList: function () {
      if (mode === 'live') return invoke('mm-staff', { action: 'staff-list' }).then(function (d) { return (d && d.staff) || []; });
      if (DEMO_ROLE !== 'admin') return demoFail('forbidden', 'admin_only');
      var all = readAll();
      return Promise.resolve(demoStaff().map(function (m) {
        return Object.assign({}, m, { clients: all.filter(function (r) { return r.consultantId === m.userId; }).length });
      }));
    },
    /* Give a login a role, change it, or deactivate it. The last administrator cannot be removed. */
    staffSave: function (userId, role, active) {
      if (mode === 'live') return invoke('mm-staff', { action: 'staff-save', userId: userId, role: role, active: !!active });
      if (DEMO_ROLE !== 'admin') return demoFail('forbidden', 'admin_only');
      if (role !== 'admin' && role !== 'consultant') return demoFail('bad_request', 'userId, role and active are required');
      var list = demoStaff();
      var m = list.filter(function (x) { return x.userId === userId; })[0];
      if (!m) return demoFail('bad_request', 'No such login');
      var otherAdmins = list.filter(function (x) { return x.userId !== userId && x.role === 'admin' && x.active; }).length;
      if (m.role === 'admin' && m.active && (role !== 'admin' || !active) && !otherAdmins) return demoFail('invalid_state', 'last_admin');
      m.role = role; m.active = !!active;
      if (!m.linkCode) m.linkCode = 'dm' + Math.random().toString(36).replace(/[^a-hj-km-np-z2-9]/g, '').slice(0, 6).padEnd(6, 'x');
      saveDemoStaff(list);
      return Promise.resolve({ member: { userId: m.userId, role: m.role, active: m.active, linkCode: m.linkCode } });
    },
    /* Assign a record to a consultant. Clients do not move: only an unassigned record, or one whose
       consultant is no longer active. */
    assign: function (ref, consultantId) {
      if (mode === 'live') return invoke('mm-staff', { action: 'assign', ref: ref, consultantId: consultantId });
      if (DEMO_ROLE !== 'admin') return demoFail('forbidden', 'admin_only');
      var rec = demoFind(ref);
      if (!rec) return demoFail('bad_request', 'No such record');
      var to = demoMember(consultantId);
      if (!to || !to.active || !to.role) return demoFail('invalid_state', 'assign_not_staff');
      var cur = rec.consultantId ? demoMember(rec.consultantId) : null;
      if (rec.consultantId && rec.consultantId !== consultantId && cur && cur.active) return demoFail('invalid_state', 'assign_already_assigned');
      demoUpdate(ref, { consultantId: consultantId, assignedAt: Date.now() },
        (rec.consultantId ? 'Reassigned (previous consultant no longer active) to ' : 'Assigned to ') + to.fullName + ' by demo user');
      return Promise.resolve({ status: 'ok' });
    },

    /* Run the credit check (billable in production).
       → {status:'report_ready', summary, pdfStatus}. Throws Error{code}. */
    runCheck: function (ref) {
      if (mode === 'live') return invoke('mm-staff', { action: 'run-check', ref: ref });
      var rec = demoRecover(ref);
      if (!rec) return demoFail('bad_request', 'No such record');
      if (allowedFrom(DEMO_IDV).indexOf(rec.status) === -1) {
        return demoFail('invalid_state', 'A credit check cannot run from status ' + rec.status);
      }
      var rep = demoReport();
      demoUpdate(ref, {
        status: 'report_ready', groupId: 'DEMO-GROUP-0001', bureauEnquiryId: rep.summary.enquiryId,
        reportJson: rep.json, reportSummary: rep.summary, affordability: rep.affordability,
        reportReadyAt: Date.now(), checkAttempt: (rec.checkAttempt || 0) + 1, pdfStatus: null
      }, 'Credit report received (sample data)' + (rec.status === 'manual_verified' ? ' — identity verified manually' : ''));
      return Promise.resolve({ status: 'report_ready', summary: rep.summary, pdfStatus: null });
    },
    fetchPdf: function (ref) {
      if (mode === 'live') return invoke('mm-staff', { action: 'fetch-pdf', ref: ref });
      return demoFail('invalid_state', 'No PDF in demo mode');
    },
    /* Staff retry of consent registration (client session expired / vendor was down).
       → {status, idvMode}; status 'manual_required' means the audit trail says why. */
    staffRegisterConsent: function (ref) {
      if (mode === 'live') return invoke('mm-staff', { action: 'register-consent', ref: ref });
      demoRecover(ref);
      setToken(ref, 'demo');
      return PMStore.registerConsent(ref);
    },
    /* → {consents}. Refused (invalid_state 'consent_never_registered') when consent was never
       registered with MortgageMAX: there is nothing to read back, and asking would send the
       person's ID number for no reason. */
    refreshConsents: function (ref) {
      if (mode === 'live') return invoke('mm-staff', { action: 'refresh-consents', ref: ref });
      var rec = demoRecover(ref);
      if (!rec) return demoFail('bad_request', 'No such record');
      if (!rec.consentRegisteredAt) return demoFail('invalid_state', 'consent_never_registered');
      return Promise.resolve({ consents: [] });
    },
    /* → {status:'consent_withdrawn', localOnly:true} when consent was never registered (nothing was
       sent to MortgageMAX), else {status:'consent_withdrawn', vendorRecorded, vendorCode?}. The
       record is withdrawn here whether or not MortgageMAX accepts it; vendorRecorded:false means
       MortgageMAX still has to be told.
       Refused while awaiting the SMS code, already withdrawn, or a credit check is running. */
    recordWithdrawal: function (ref, reason) {
      if (mode === 'live') return invoke('mm-staff', { action: 'record-withdrawal', ref: ref, reason: reason || '' });
      var rec = demoRecover(ref);
      if (!rec) return demoFail('bad_request', 'No such record');
      if (['awaiting_otp', 'consent_withdrawn', 'check_in_flight'].indexOf(rec.status) !== -1) {
        return demoFail('invalid_state', 'Nothing to withdraw from status ' + rec.status);
      }
      var registered = !!rec.consentRegisteredAt;
      demoUpdate(ref, { status: 'consent_withdrawn', consentWithdrawnAt: Date.now() },
        (registered ? 'Consent withdrawal recorded with MortgageMax' : 'Consent withdrawal recorded (never registered with MortgageMax — nothing sent)') +
        (reason ? ': ' + reason : ''));
      return Promise.resolve(registered ? { status: 'consent_withdrawn', vendorRecorded: true }
                                        : { status: 'consent_withdrawn', localOnly: true });
    },
    /* Stale-state recovery for one record (mm-staff 'recover'): a check left running past
       5 minutes → check_failed; identity questions left open past the answer window → idv_failed.
       Idempotent. → {status} */
    recover: function (ref) {
      if (mode === 'live') return invoke('mm-staff', { action: 'recover', ref: ref });
      var rec = demoRecover(ref);
      if (!rec) return demoFail('bad_request', 'No such record');
      return Promise.resolve({ status: rec.status });
    },
    /* Only from config_error, once the credential problem is fixed: moves the record to the
       status its data says it had reached (mm-staff 'clear-config-error'). → {status} */
    clearConfigError: function (ref) {
      if (mode === 'live') return invoke('mm-staff', { action: 'clear-config-error', ref: ref });
      var rec = demoFind(ref);
      if (!rec) return demoFail('bad_request', 'No such record');
      if (rec.status !== 'config_error') return demoFail('invalid_state', 'This record has no system error to clear');
      var patch = {};
      if (rec.reportJson) patch.status = 'report_ready';
      else if (rec.checkStartedAt) {
        patch.status = 'check_failed';
        patch.checkErrorCode = 'config_error_cleared';
        patch.checkErrorText = 'The credit check was stopped by a system configuration error that has since been cleared.';
      }
      else if (!rec.consentRegisteredAt) patch.status = 'consent_confirmed';
      else if (rec.idvPassedAt) patch.status = 'idv_passed';
      else if (rec.manualVerifiedAt) patch.status = 'manual_verified';
      else if ((rec.idvAttempts || 0) > 0) patch.status = 'idv_failed';
      else patch.status = DEMO_IDV === 'off' ? 'idv_waived' : 'consent_registered';
      demoUpdate(ref, patch, 'System error cleared by demo user');
      return Promise.resolve({ status: patch.status });
    },

    /* Short-lived (60 s) signed URL for the stored report PDF; logs the access. */
    pdfUrl: function (rec) {
      if (mode !== 'live') return demoFail('invalid_state', 'No PDF in demo mode');
      if (!rec || !rec.reportPdfPath) return demoFail('invalid_state', 'No PDF stored for this record');
      return sb.storage.from('credit-reports').createSignedUrl(rec.reportPdfPath, 60).then(function (res) {
        if (res.error || !res.data) throw mkErr({ code: 'server_error', message: 'Could not open the PDF' });
        return PMStore.logAccess(rec.ref, 'download_pdf').then(function () { return res.data.signedUrl; });
      });
    },
    /* Manual identity verification (the only route past failed / unavailable identity questions):
       upload the ID copy through a one-time URL mm-staff issues, then record the consultant's
       attestation. attestationVersion must be the one shown. → {status:'manual_verified'}. */
    manualVerify: function (ref, file, attestationVersion) {
      if (!file) return demoFail('bad_request', 'Choose the ID copy to upload');
      if (ID_DOC_TYPES.indexOf(file.type) === -1) return demoFail('bad_request', 'The ID copy must be a PDF, JPG or PNG');
      if (!file.size || file.size > ID_DOC_MAX_BYTES) return demoFail('bad_request', 'The ID copy is empty or larger than 10 MB');
      if (mode === 'live') {
        return invoke('mm-staff', { action: 'manual-upload-url', ref: ref, contentType: file.type }).then(function (u) {
          return sb.storage.from('id-documents').uploadToSignedUrl(u.path, u.token, file, { contentType: file.type })
            .then(function (res) {
              if (res.error) throw mkErr({ code: 'server_error', message: 'The upload failed — try again' });
              return invoke('mm-staff', {
                action: 'manual-verify', ref: ref, path: u.path, attestationVersion: attestationVersion, attested: true
              });
            });
        });
      }
      var rec = demoRecover(ref);
      if (!rec) return demoFail('bad_request', 'No such record');
      if (attestationVersion !== ATTESTATION.version) return demoFail('invalid_state', 'manual_attestation_changed');
      var can = manualVerifyCheck(rec);
      if (!can.ok) return demoFail('invalid_state', 'manual_not_allowed:' + can.reason);
      demoUpdate(ref, {
        status: 'manual_verified', manualVerifiedAt: Date.now(), manualVerificationId: 1,
        demoEvidence: {
          created_at: new Date().toISOString(), verified_by_label: 'demo user', attestation_version: ATTESTATION.version,
          attestation_text: ATTESTATION.text, document_type: file.type, document_bytes: file.size,
          document_path: null, document_deleted_at: null
        }
      }, 'Identity verified manually by demo user (ID copy uploaded + Experian attestation)');
      return Promise.resolve({ status: 'manual_verified' });
    },
    /* Staff: a fresh identity-check session for a client whose 30-minute session lapsed. The token
       is shown once (to build the link) and replaces any earlier one. → {token, expiresAt} */
    reissueIdvLink: function (ref) {
      if (mode === 'live') return invoke('mm-staff', { action: 'reissue-idv-link', ref: ref });
      var rec = demoRecover(ref);
      if (!rec) return demoFail('bad_request', 'No such record');
      var can = idvLinkCheck(rec, DEMO_IDV);
      if (!can.ok) return demoFail('invalid_state', 'idv_link_not_allowed:' + can.reason);
      var token = randomHex(32);
      setToken(ref, token);
      demoUpdate(ref, {}, 'Identity-check link re-issued by demo user (valid 24 hours; any earlier link stops working)');
      return Promise.resolve({ token: token, expiresAt: new Date(Date.now() + IDV_LINK_TTL_MS).toISOString() });
    },
    /* Client form: take the session token from a re-issued link (index.html#resume=REF&t=TOKEN). */
    adoptIdvToken: function (ref, token) { setToken(ref, token); },
    /* The evidence rows for a record, newest first (staff read; written only by the server). */
    manualEvidence: function (rec) {
      if (mode !== 'live') return Promise.resolve(rec && rec.demoEvidence ? [rec.demoEvidence] : []);
      return sb.from('manual_verifications')
        .select('id, created_at, verified_by_label, attestation_version, attestation_text, document_path, document_type, document_bytes, document_sha256, document_deleted_at')
        .eq('ref', rec.ref).order('created_at', { ascending: false }).limit(10)
        .then(function (res) {
          if (res.error) throw new Error(res.error.message);
          return res.data || [];
        });
    },
    /* Short-lived (60 s) signed URL for a stored ID copy; logs the access. */
    idDocumentUrl: function (ref, path) {
      if (mode !== 'live') return demoFail('invalid_state', 'No stored ID copy in demo mode');
      return sb.storage.from('id-documents').createSignedUrl(path, 60).then(function (res) {
        if (res.error || !res.data) throw mkErr({ code: 'server_error', message: 'Could not open the ID copy' });
        return PMStore.logAccess(ref, 'view_id_document').then(function () { return res.data.signedUrl; });
      });
    },
    /* action: 'view' | 'download_pdf' | 'view_raw' | 'view_id_document'. Never throws — access logging must not block viewing. */
    logAccess: function (ref, action) {
      if (mode !== 'live') return Promise.resolve();
      /* never blocks viewing — but a broken audit log must not be invisible either */
      return sb.from('report_access_log').insert({ ref: ref, action: action })
        .then(function (res) { if (res && res.error) console.error('access log failed:', res.error.message); },
          function (e) { console.error('access log failed:', e && e.message); });
    },
    accessLog: function (ref) {
      if (mode !== 'live') return Promise.resolve([]);
      return sb.from('report_access_log').select('created_at, user_id, action').eq('ref', ref)
        .order('created_at', { ascending: false }).limit(20)
        .then(function (res) {
          if (res.error || !res.data.length) return [];
          var ids = res.data.map(function (x) { return x.user_id; }).filter(function (v, i, a) { return a.indexOf(v) === i; });
          return sb.from('staff_profiles').select('user_id, full_name').in('user_id', ids).then(function (p) {
            var names = {};
            (p.data || []).forEach(function (x) { names[x.user_id] = x.full_name; });
            return res.data.map(function (x) { return Object.assign({}, x, { name: names[x.user_id] || '' }); });
          }, function () { return res.data; });
        });
    },
    consentEvents: function (ref) {
      if (mode !== 'live') return Promise.resolve([]);
      return sb.from('consent_events').select('created_at, event, consent_type_id, consent_version, granted, vendor_created_date, created_by')
        .eq('ref', ref).order('created_at', { ascending: true })
        .then(function (res) { return res.error ? [] : res.data; });
    },

    /* The signed-in consultant's details, sent to MortgageMax on each credit check. */
    myProfile: function () {
      if (mode !== 'live') {
        try { return Promise.resolve(JSON.parse(localStorage.getItem(PROFILE_KEY))); } catch (e) { return Promise.resolve(null); }
      }
      return sb.auth.getUser().then(function (u) {
        var user = u.data && u.data.user;
        if (!user) return null;
        return sb.from('staff_profiles').select('*').eq('user_id', user.id).maybeSingle().then(function (res) {
          return res.data || { user_id: user.id, full_name: '', email: user.email || '', cell: '', branch_name: '' };
        });
      });
    },
    saveMyProfile: function (p) {
      var clean = {
        full_name: String(p.full_name || '').trim(), email: String(p.email || '').trim(),
        cell: String(p.cell || '').trim(), branch_name: String(p.branch_name || '').trim()
      };
      if (!clean.full_name || !clean.email) return demoFail('bad_request', 'Name and email are required');
      if (mode !== 'live') { localStorage.setItem(PROFILE_KEY, JSON.stringify(clean)); return Promise.resolve(clean); }
      return sb.auth.getUser().then(function (u) {
        var user = u.data && u.data.user;
        if (!user) throw mkErr({ code: 'unauthenticated', message: 'Sign in required' });
        clean.user_id = user.id;
        clean.updated_at = new Date().toISOString();
        return sb.from('staff_profiles').upsert(clean).select().maybeSingle().then(function (res) {
          if (res.error) throw mkErr({ code: 'server_error', message: res.error.message });
          return res.data;
        });
      });
    },

    /* Destroy on request: removes the stored PDF with the record (mm-staff delete-record). */
    remove: function (ref) {
      if (mode === 'live') return invoke('mm-staff', { action: 'delete-record', ref: ref });
      var rec = demoRecover(ref);
      if (rec && rec.status === 'check_in_flight') {
        return demoFail('invalid_state', 'A credit check is running for this record — try again shortly');
      }
      writeAll(readAll().filter(function (r) { return r.ref !== ref; }));
      return Promise.resolve();
    },

    /* register live-refresh: Supabase realtime in live mode,
       cross-tab storage events in demo mode */
    onChange: function (cb) {
      if (mode === 'live') {
        /* credit_check_signals carries only {ref, status} (hardening migration). Until that
           migration is applied, credit_checks itself is still published — listen to both. */
        /* One channel PER table: a binding the server rejects (table not in the publication) only
           fails its own channel. Signals: INSERT only, so the sweep's pruning DELETEs are never sent.
           Once the hardening migration is applied everywhere, the credit_checks channel can go. */
        var sub = function (name, table, event) {
          return sb.channel(name)
            .on('postgres_changes', { event: event, schema: 'public', table: table }, cb)
            .subscribe(function (s, err) {
              if (s === 'CHANNEL_ERROR' || s === 'TIMED_OUT') console.warn('realtime ' + table + ':', s, err || '');
            });
        };
        sub('cc_signals_admin', 'credit_check_signals', 'INSERT');
        sub('cc_rows_admin', 'credit_checks', '*');
      } else {
        window.addEventListener('storage', cb);
      }
    },

    /* ===== demo-mode utilities ===== */

    clearAll: function () {
      if (mode !== 'demo') return Promise.resolve();
      localStorage.removeItem(KEY);
      return Promise.resolve();
    },
    seedDemo: function () {
      if (mode !== 'demo') return Promise.resolve();
      var now = Date.now();
      function id(first12) { return first12 + saIdCheckDigit(first12); }
      var rows = [
        {
          firstNames: 'Thandiwe Grace', surname: 'Nkosi', idType: 'said',
          idNumber: id('880412052308'), email: 'thandiwe.n@example.com', cell: '0824417702',
          street: '14 Jacaranda Ave', suburb: 'Waterkloof', city: 'Pretoria',
          province: 'Gauteng', postalCode: '0181',
          employmentStatus: 'Full-time employed', maritalStatus: 'Married out of community',
          referral: 'Estate agent referral',
          grossIncome: 52000, totalDeductions: 11400, monthlyExpenses: 18500, housingPayment: 9800,
          _age: 3 * 864e5, _status: 'report_ready', _consultant: DEMO_ME
        },
        {
          firstNames: 'Pieter', surname: 'van der Merwe', idType: 'said',
          idNumber: id('790825583108'), email: 'pvdm@example.com', cell: '0731260988',
          street: '203 Silver Oak Close', suburb: 'Faerie Glen', city: 'Pretoria',
          province: 'Gauteng', postalCode: '0081',
          employmentStatus: 'Self-employed', maritalStatus: 'Married in community of property',
          referral: 'Returning client',
          grossIncome: 88000, totalDeductions: 24100, monthlyExpenses: 31000, housingPayment: 15600,
          _age: 1 * 864e5, _status: 'idv_waived', _consultant: 'demo-c2' /* a consultant who has left */
        },
        {
          firstNames: 'Ayesha', surname: 'Patel', idType: 'said',
          idNumber: id('930217034009'), email: 'ayesha.patel@example.com', cell: '0615532247',
          street: '7B Protea Street', suburb: 'Umhlanga Rocks', city: 'Durban',
          province: 'KwaZulu-Natal', postalCode: '4320',
          employmentStatus: 'Full-time employed', maritalStatus: 'Single',
          referral: 'Google search',
          grossIncome: 41500, totalDeductions: 9300, monthlyExpenses: 14200, housingPayment: 8500,
          _age: 2 * 36e5, _status: 'awaiting_otp'
        }
      ];
      var list = readAll();
      rows.forEach(function (row) {
        var status = row._status, age = row._age, owner = row._consultant || null;
        delete row._status; delete row._age; delete row._consultant;
        var rec = Object.assign({}, row, {
          ref: makeRef(), createdAt: now - age, status: 'awaiting_otp',
          otp: makeOtp(), otpExpires: now - age + 10 * 60000, otpAttempts: 0, idvAttempts: 0, demo: true,
          consultantId: owner, assignedAt: owner ? now - age : null,
          audit: [{ at: now - age, event: 'Form submitted by client (sample data)' }]
        });
        if (status !== 'awaiting_otp') {
          rec.status = 'idv_waived';
          rec.consentConfirmedAt = now - age + 4 * 60000;
          rec.consentRegisteredAt = now - age + 4 * 60000 + 3000;
          rec.otp = null;
          rec.audit.push({ at: now - age + 4 * 60000, event: 'Consent confirmed via SMS one-time PIN' });
          rec.audit.push({ at: now - age + 4 * 60000 + 3000, event: 'Consent registered with MortgageMax; identity questions waived by configuration' });
        }
        if (status === 'report_ready') {
          var rep = demoReport();
          rec.status = 'report_ready';
          rec.groupId = 'DEMO-GROUP-0001';
          rec.bureauEnquiryId = rep.summary.enquiryId;
          rec.reportJson = rep.json;
          rec.reportSummary = rep.summary;
          rec.affordability = rep.affordability;
          rec.reportReadyAt = now - age + 9 * 60000;
          rec.audit.push({ at: now - age + 9 * 60000, event: 'Credit report received (sample data)' });
        }
        list.push(rec);
      });
      writeAll(list);
      return Promise.resolve();
    }
  };

  window.PMStore = PMStore;
})();
