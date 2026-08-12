/* Pro Mortgage credit-check tool — data layer.
   Dual mode, one async API:
     LIVE — Supabase (config.js filled in): anon browsers can only call the
            submit/confirm RPCs; staff read the table after Supabase Auth login.
     DEMO — localStorage in this browser, no login (config.js blank).
   Remaining production TODOs live in supabase-setup.sql (SMS gateway)
   and admin.html (TransUnion API call). */
(function () {
  'use strict';

  var KEY = 'pm_credit_checks_v1';
  var cfg = window.PM_CONFIG || {};
  var live = !!(cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY);
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
  function demoUpdate(ref, patch, auditEvent) {
    var list = readAll();
    var i = list.findIndex(function (r) { return r.ref === ref; });
    if (i === -1) return null;
    Object.assign(list[i], patch);
    if (auditEvent) list[i].audit.push({ at: Date.now(), event: auditEvent });
    writeAll(list);
    return list[i];
  }

  /* ---------- live-mode row mapping (snake_case -> camelCase) ---------- */
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
      consentConfirmedAt: r.consent_confirmed_at ? Date.parse(r.consent_confirmed_at) : null,
      consentUA: r.consent_ua || '',
      audit: r.audit || []
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

  var STATUS = {
    awaiting_otp:      { label: 'Awaiting SMS code',  chip: 'chip-awaiting' },
    consent_confirmed: { label: 'Consent confirmed',  chip: 'chip-confirmed' },
    report_requested:  { label: 'Report requested',   chip: 'chip-requested' }
  };

  var PMStore = {
    mode: mode,
    STATUS: STATUS,
    validSaId: validSaId,
    saIdDerive: saIdDerive,
    saIdCheckDigit: saIdCheckDigit,

    /* ===== client form API ===== */

    /* returns {ref, demo_otp} — demo_otp present until the SMS gateway phase */
    submit: function (data) {
      if (mode === 'live') {
        return sb.rpc('submit_credit_check', { payload: data }).then(function (res) {
          if (res.error) throw new Error(res.error.message);
          return res.data;
        });
      }
      var rec = Object.assign({}, data, {
        ref: makeRef(),
        createdAt: Date.now(),
        status: 'awaiting_otp',
        otp: makeOtp(),
        otpExpires: Date.now() + 10 * 60 * 1000,
        otpAttempts: 0,
        audit: [auditEntry('Form submitted by client')]
      });
      var list = readAll();
      list.push(rec);
      writeAll(list);
      return Promise.resolve({ ref: rec.ref, demo_otp: rec.otp });
    },

    /* returns {ok} or {ok:false, error: not_found|already_confirmed|expired|mismatch|too_many_attempts} */
    confirmConsent: function (ref, otp) {
      if (mode === 'live') {
        return sb.rpc('confirm_consent', { p_ref: ref, p_otp: otp }).then(function (res) {
          if (res.error) throw new Error(res.error.message);
          return res.data;
        });
      }
      var rec = readAll().find(function (r) { return r.ref === ref; });
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
      return Promise.resolve({ ok: true, ref: ref });
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

    all: function () {
      if (mode === 'live') {
        return sb.from('credit_checks').select('*').order('created_at', { ascending: false })
          .then(function (res) {
            if (res.error) throw new Error(res.error.message);
            return res.data.map(fromRow);
          });
      }
      return Promise.resolve(readAll().sort(function (a, b) { return b.createdAt - a.createdAt; }));
    },
    get: function (ref) {
      if (mode === 'live') {
        return sb.from('credit_checks').select('*').eq('ref', ref).maybeSingle()
          .then(function (res) {
            if (res.error) throw new Error(res.error.message);
            return res.data ? fromRow(res.data) : null;
          });
      }
      return Promise.resolve(readAll().find(function (r) { return r.ref === ref; }) || null);
    },
    requestReport: function (ref) {
      /* PRODUCTION TODO (TransUnion phase): call the Consumer Profile API
         here and attach the returned report to the record. */
      var event = 'ITC report requested (TransUnion integration pending)';
      if (mode === 'live') {
        return this.get(ref).then(function (r) {
          if (!r) throw new Error('Record not found');
          return sb.from('credit_checks')
            .update({ status: 'report_requested', audit: r.audit.concat([auditEntry(event)]) })
            .eq('ref', ref)
            .then(function (res) { if (res.error) throw new Error(res.error.message); });
        });
      }
      demoUpdate(ref, { status: 'report_requested' }, event);
      return Promise.resolve();
    },
    remove: function (ref) {
      if (mode === 'live') {
        return sb.from('credit_checks').delete().eq('ref', ref)
          .then(function (res) { if (res.error) throw new Error(res.error.message); });
      }
      writeAll(readAll().filter(function (r) { return r.ref !== ref; }));
      return Promise.resolve();
    },

    /* register live-refresh: Supabase realtime in live mode,
       cross-tab storage events in demo mode */
    onChange: function (cb) {
      if (mode === 'live') {
        sb.channel('credit_checks_admin')
          .on('postgres_changes', { event: '*', schema: 'public', table: 'credit_checks' }, cb)
          .subscribe();
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
          _age: 3 * 864e5, _status: 'report_requested'
        },
        {
          firstNames: 'Pieter', surname: 'van der Merwe', idType: 'said',
          idNumber: id('790825583108'), email: 'pvdm@example.com', cell: '0731260988',
          street: '203 Silver Oak Close', suburb: 'Faerie Glen', city: 'Pretoria',
          province: 'Gauteng', postalCode: '0081',
          employmentStatus: 'Self-employed', maritalStatus: 'Married in community of property',
          referral: 'Returning client',
          grossIncome: 88000, totalDeductions: 24100, monthlyExpenses: 31000, housingPayment: 15600,
          _age: 1 * 864e5, _status: 'consent_confirmed'
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
        var status = row._status, age = row._age;
        delete row._status; delete row._age;
        var rec = Object.assign({}, row, {
          ref: makeRef(), createdAt: now - age, status: 'awaiting_otp',
          otp: makeOtp(), otpExpires: now - age + 10 * 60000, otpAttempts: 0, demo: true,
          audit: [{ at: now - age, event: 'Form submitted by client (sample data)' }]
        });
        if (status !== 'awaiting_otp') {
          rec.status = 'consent_confirmed';
          rec.consentConfirmedAt = now - age + 4 * 60000;
          rec.otp = null;
          rec.audit.push({ at: now - age + 4 * 60000, event: 'Consent confirmed via SMS one-time PIN' });
        }
        if (status === 'report_requested') {
          rec.status = 'report_requested';
          rec.audit.push({ at: now - age + 9 * 60000, event: 'ITC report requested (TransUnion integration pending)' });
        }
        list.push(rec);
      });
      writeAll(list);
      return Promise.resolve();
    }
  };

  window.PMStore = PMStore;
})();
