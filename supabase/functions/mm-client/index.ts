// mm-client — the ANONYMOUS-facing Edge Function (BUILD-PLAN D2, D14).
// Called by index.html. It can serve the consent wording, register consent with MortgageMax after
// the client confirms their SMS OTP, and run the identity-verification questions. It can NEVER run
// a credit check — that path exists only in mm-staff, behind a staff login.
//
// Authorisation: 'consent-types' is public (the wording is not secret). Every other action needs
// { ref, idv_token }: confirm_consent minted the token once (32 random bytes); only its sha256 is
// stored, with a 30-minute expiry, in credit_check_secrets (unreadable by any client role).
// Deploy with --no-verify-jwt: the project's publishable key is not a JWT.
//
// 'submit' creates the application and SMSes the consent code (SMS_MODE, _shared/sms.ts); it hands
// back a one-time otp_session (sha256 stored) that alone may ask for 'resend-otp'.
//
// POST { action: 'consent-types' }
// POST { action: 'submit', payload }                → { ref, otp_session, sms, demo_otp (not live) }
// POST { action: 'resend-otp', ref, otp_session }   → { sent, reason?, retryAfter, sendsLeft }
// POST { ref, idv_token, action: 'register-consent' | 'idv-start' | 'idv-answer' | 'idv-expire', answers? }

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { fail, ok, preflight } from "../_shared/http.ts";
import { callVendor, configFromEnv, type MmConfig, succeeded, type VendorResult } from "../_shared/mmax.ts";
import { logCall, serviceClient, sha256Hex, transition } from "../_shared/db.ts";
import { mockFetch } from "../_shared/mock.ts";
import { type Ctx, idvModeFromEnv, type Mode, publicConsentTypes, registerConsent } from "../_shared/register.ts";
import { recoverStale } from "../_shared/recover.ts";
import { idvIdType, personIdFor } from "../_shared/idnumber.ts";
import { IDV_ANSWER_WINDOW_MS } from "../_shared/states.ts";
import {
  OTP_COOLDOWN_S, OTP_FAILED_RETRY_S, OTP_MAX_PER_CELL_24H, OTP_MAX_SENDS, otpMessage, sendSms, type SmsConfig, smsConfigFromEnv, smsGuard,
} from "../_shared/sms.ts";

const APP_NAME = "promortgage-credit-check";
const APP_VERSION = "2026.09.26";
const SOURCE_SYSTEM = "PMSA-CreditCheck";
const MAX_IDV_ROUNDS = 2;
// C5: identity-question rounds per ID number across ALL records, rolling 24 h. Stops anyone from
// harvesting a person's credit-file facts (or running up IDV calls) by submitting fresh forms.
const MAX_IDV_ROUNDS_PER_PERSON_24H = 3;
// submit_credit_check's own refusals — safe to pass to the form as codes (it maps them to copy).
const SUBMIT_REFUSALS = new Set([
  "invalid_id_number", "invalid_passport_number", "invalid_id_type", "invalid_cell", "too_many_submissions",
]);

type SendOutcome =
  | { missing: true }
  | {
    missing?: false; sent: boolean; reason?: string; retryAfter?: number; sendsLeft?: number;
    uncertain?: boolean; demoCode?: string;
  };

/**
 * Make a code and SMS it. claim_otp_send (migration 20260928) does every check and writes the
 * sms_log row BEFORE the send; record_sms_result closes it. The code is returned to the browser
 * ONLY outside live mode. { missing: true } = the migration is not applied yet.
 */
async function sendCode(sb: SupabaseClient, sms: SmsConfig, ref: string, sessionHash: string, isResend: boolean): Promise<SendOutcome> {
  const c = await sb.rpc("claim_otp_send", {
    p_ref: ref, p_session_hash: sessionHash, p_is_resend: isResend, p_mode: sms.mode,
    p_cooldown_s: OTP_COOLDOWN_S, p_max_sends: OTP_MAX_SENDS, p_cell_max: OTP_MAX_PER_CELL_24H, p_daily_max: sms.dailyMax,
  });
  if (c.error) {
    if (c.error.code === "PGRST202" || /claim_otp_send/.test(c.error.message ?? "")) return { missing: true };
    throw new Error(`server_error: ${c.error.message}`);
  }
  const d = c.data as { ok: boolean; reason?: string; retry_after?: number; code?: string; cell?: string; sms_id?: number; send_no?: number };
  if (!d?.ok) {
    if (d?.reason === "daily_limit") console.error(JSON.stringify({ event: "sms_daily_limit", ref, dailyMax: sms.dailyMax }));
    return { sent: false, reason: d?.reason ?? "server_error", retryAfter: d?.retry_after };
  }
  const r = await sendSms(sms, { to: d.cell!, text: otpMessage(sms.brand, d.code!), customerId: ref });
  const rec = await sb.rpc("record_sms_result", {
    p_sms_id: d.sms_id, p_status: r.status, p_http: r.http, p_event_id: r.eventId, p_error: r.errorCode, p_cost: r.cost,
  });
  if (rec.error) console.error(JSON.stringify({ event: "sms_record_failed", ref, message: rec.error.message }));
  // Never the number, the code or the text.
  console.log(JSON.stringify({
    event: "sms_send", ref, mode: sms.mode, sendNo: d.send_no, status: r.status, http: r.http,
    errorCode: r.errorCode, latencyMs: r.latencyMs,
  }));
  if (r.http === 401 || r.http === 403) console.error(JSON.stringify({ event: "sms_config_error", ref, http: r.http }));
  const sendsLeft = Math.max(0, OTP_MAX_SENDS - (d.send_no ?? OTP_MAX_SENDS));
  const demoCode = sms.mode === "live" ? undefined : d.code;
  // record_sms_result gives a failed send back (sendsLeft + 1) and allows a retry after 15 s.
  if (r.status === "failed") return { sent: false, reason: "send_failed", retryAfter: OTP_FAILED_RETRY_S, sendsLeft: sendsLeft + 1, demoCode };
  return { sent: true, uncertain: r.status === "unknown", retryAfter: OTP_COOLDOWN_S, sendsLeft, demoCode };
}

Deno.serve(async (req) => {
  const origin = req.headers.get("Origin");
  if (req.method === "OPTIONS") return preflight(origin);
  if (req.method !== "POST") return fail("bad_request", "POST only", origin);

  let body: { ref?: string; idv_token?: string; action?: string; answers?: unknown; payload?: unknown; otp_session?: string };
  try {
    body = await req.json();
  } catch {
    return fail("bad_request", "Body must be JSON", origin);
  }
  const { ref, idv_token: token, action } = body;
  if (!action) return fail("bad_request", "action is required", origin);

  let cfg: MmConfig;
  let sb: SupabaseClient;
  try {
    cfg = configFromEnv();
    sb = serviceClient();
  } catch (e) {
    console.error(JSON.stringify({ event: "config_error", message: String(e) }));
    return fail("config_error", "Service is not configured", origin);
  }
  const mode: Mode = Deno.env.get("MM_MODE") === "live" ? "live" : "mock";
  const idvMode = idvModeFromEnv();
  const fetchImpl = mode === "mock" ? mockFetch : undefined;
  const requestId = crypto.randomUUID();

  // ---- public: the consent wording the form must show ----------------------------------------
  if (action === "consent-types") {
    const ctx: Ctx = {
      sb, cfg, mode, fetchImpl,
      log: (api, method, path, r) => logCall(sb, { ref: null, requestId, api, method, path, result: r, redactValues: [], env: cfg.env }),
    };
    try {
      return ok({ types: await publicConsentTypes(ctx), mode }, origin);
    } catch (e) {
      const msg = String(e instanceof Error ? e.message : e);
      console.error(JSON.stringify({ event: "consent_types_failed", message: msg }));
      return fail(msg.startsWith("config_error") ? "config_error" : "vendor_error", "Consent wording is unavailable", origin);
    }
  }

  // ---- the form, and its SMS code ------------------------------------------------------------
  // The browser no longer calls submit_credit_check itself: the code must never reach it (live).
  if (action === "submit" || action === "resend-otp") {
    let sms: SmsConfig;
    try {
      sms = smsConfigFromEnv();
    } catch (e) {
      console.error(JSON.stringify({ event: "sms_config_error", message: String(e instanceof Error ? e.message : e) }));
      return fail("config_error", "Service is not configured", origin);
    }
    const unsafe = smsGuard(sms, cfg.env);
    if (unsafe) {
      console.error(JSON.stringify({ event: "sms_config_error", message: unsafe }));
      return fail("config_error", "Service is not configured", origin);
    }
    try {
      if (action === "submit") {
        const p = body.payload;
        if (!p || typeof p !== "object" || Array.isArray(p)) return fail("bad_request", "payload is required", origin);
        const sub = await sb.rpc("submit_credit_check", { payload: p });
        if (sub.error) {
          const m = sub.error.message ?? "";
          if (SUBMIT_REFUSALS.has(m)) return fail("bad_request", m, origin);
          throw new Error(`server_error: ${m}`);
        }
        const d = sub.data as { ref: string; demo_otp?: string };
        const session = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");
        const out = await sendCode(sb, sms, d.ref, await sha256Hex(session), false);
        if (out.missing) {
          // Migration 20260928 not applied: submit_credit_check still made the code and returned it.
          // Fine for mock/test; never for live (no limits, no log) — the row just expires.
          if (sms.mode === "live") {
            console.error(JSON.stringify({ event: "sms_config_error", message: "SMS_MODE=live before migration 20260928" }));
            return fail("config_error", "Service is not configured", origin);
          }
          return ok({ ref: d.ref, demo_otp: d.demo_otp ?? null, sms: { sent: true, mode: sms.mode, canResend: false } }, origin);
        }
        return ok({
          ref: d.ref, otp_session: session, demo_otp: out.demoCode ?? null,
          sms: {
            sent: out.sent, reason: out.reason, uncertain: out.uncertain ?? false, retryAfter: out.retryAfter ?? 0,
            sendsLeft: out.sendsLeft ?? 0, mode: sms.mode, canResend: true,
          },
        }, origin);
      }

      // resend-otp: only the browser that submitted holds otp_session.
      const session = body.otp_session;
      if (!ref || typeof session !== "string" || session.length < 32) return fail("forbidden", "Invalid or expired session", origin);
      const out = await sendCode(sb, sms, ref, await sha256Hex(session), true);
      if (out.missing) return ok({ sent: false, reason: "unavailable" }, origin);
      if (!out.sent && (out.reason === "forbidden" || out.reason === "not_found")) {
        return fail("forbidden", "Invalid or expired session", origin);
      }
      return ok({
        sent: out.sent, reason: out.reason, uncertain: out.uncertain ?? false, retryAfter: out.retryAfter ?? 0,
        sendsLeft: out.sendsLeft, demo_otp: out.demoCode ?? null, mode: sms.mode,
      }, origin);
    } catch (e) {
      console.error(JSON.stringify({ event: "mm_client_error", action, message: String(e instanceof Error ? e.message : e) }));
      return fail("server_error", "Something went wrong", origin);
    }
  }

  // ---- everything else: ref + one-time token -------------------------------------------------
  if (!ref || !token) return fail("bad_request", "ref and idv_token are required", origin);
  const { data: secret } = await sb.from("credit_check_secrets")
    .select("idv_token_hash, idv_token_expires, verification_request_number").eq("ref", ref).maybeSingle();
  if (!secret?.idv_token_hash || secret.idv_token_hash !== await sha256Hex(token)) {
    return fail("forbidden", "Invalid or expired session", origin);
  }
  if (!secret.idv_token_expires || new Date(secret.idv_token_expires) < new Date()) {
    return fail("forbidden", "Invalid or expired session", origin);
  }
  const { data: row } = await sb.from("credit_checks").select("*").eq("ref", ref).maybeSingle();
  if (!row) return fail("forbidden", "Invalid or expired session", origin);

  // C4/C15: the number sent is the one id_type names; mm_person_id is also redacted from logs.
  const personId: string = personIdFor(row);
  const log = (api: "credit" | "consent", method: string, path: string, result: VendorResult) =>
    logCall(sb, { ref, requestId, api, method, path, result, redactValues: [personId, row.mm_person_id], env: cfg.env });
  const ctx: Ctx = { sb, cfg, mode, fetchImpl, log };
  const configFailure = async (r: VendorResult, from: string[], restore: Record<string, unknown> = {}) => {
    // 401/403 from the vendor = our credentials/config, never the client's fault. mm-staff
    // 'clear-config-error' puts the record back once the credentials are fixed (C2).
    await transition(sb, ref, from, { ...restore, status: "config_error" }, `MortgageMax rejected our credentials (${r.http})`);
    return fail("config_error", "We could not complete this step. Your consultant will contact you.", origin);
  };
  const canRetry = () => (row.idv_attempts ?? 0) < MAX_IDV_ROUNDS;

  try {
    // C1: stale-state recovery for this caller's own record, before any action.
    const { recovered } = await recoverStale(sb, row);

    // ======================================================================================
    if (action === "register-consent") {
      const out = await registerConsent(ctx, row, "promortgagesa-web");
      if (!out.ok) {
        return fail(out.code, out.message, origin, { vendorCode: out.vendorCode, traceId: out.traceId });
      }
      return ok({ status: out.status, idvMode: out.idvMode, reason: out.reason }, origin);
    }

    // ======================================================================================
    if (action === "idv-start") {
      if (idvMode === "off") return ok({ skipped: true, status: row.status }, origin);
      const retry = row.status === "idv_failed" && (row.idv_attempts ?? 0) < MAX_IDV_ROUNDS;
      if (row.status !== "consent_registered" && !retry) {
        return fail("invalid_state", `Identity check cannot start from status ${row.status}`, origin);
      }
      if (!personId) return fail("bad_request", "No ID number on record", origin);

      // C5: per-person limit across every record for this ID number (this one included), claimed
      // ATOMICALLY: claim_idv_round (hardening migration) takes a per-person advisory lock, counts
      // and claims in one transaction, so a burst of simultaneous starts cannot exceed the limit.
      // Until that migration is applied, fall back to check-then-claim (small race, documented).
      const round = (row.idv_attempts ?? 0) + 1;
      const toManualLimit = async () => {
        const moved = await transition(sb, ref, [row.status], { status: "manual_required" },
          "Too many identity-question rounds for this ID number in 24 hours");
        if (!moved) return fail("invalid_state", "Identity check already started", origin);
        return ok({ status: "manual_required" }, origin);
      };
      const rpc = await sb.rpc("claim_idv_round", { p_ref: ref, p_from: row.status, p_max: MAX_IDV_ROUNDS_PER_PERSON_24H });
      const rpcMissing = !!rpc.error && (rpc.error.code === "PGRST202" || /claim_idv_round/.test(rpc.error.message ?? ""));
      if (rpc.error && !rpcMissing) throw new Error(`server_error: ${rpc.error.message}`);
      if (!rpcMissing) {
        const r = rpc.data as { ok: boolean; reason?: string };
        if (!r?.ok && r?.reason === "limit") return await toManualLimit();
        if (!r?.ok) return fail("invalid_state", "Identity check already started", origin);
      } else {
        if (row.mm_person_id) {
          const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
          const { data: recent, error: recentErr } = await sb.from("credit_checks").select("idv_attempts")
            .eq("mm_person_id", row.mm_person_id).gte("idv_started_at", since);
          if (recentErr) throw new Error(`server_error: ${recentErr.message}`);
          const rounds = (recent ?? []).reduce((n: number, r: { idv_attempts?: number | null }) => n + (r.idv_attempts ?? 0), 0);
          if (rounds >= MAX_IDV_ROUNDS_PER_PERSON_24H) return await toManualLimit();
        }
        // Claim the round BEFORE calling the vendor: a concurrent second start gets 409 instead of
        // overwriting the session reference that the first request's questions belong to.
        const claimed = await transition(sb, ref, [row.status], {
          status: "idv_in_progress", idv_questions: null, idv_result: null,
          idv_started_at: new Date().toISOString(), idv_attempts: round,
        }, `Identity questions requested (round ${round})`);
        if (!claimed) return fail("invalid_state", "Identity check already started", origin);
      }

      // What the claim overwrote — put back when the round does not count (C4).
      const beforeClaim = {
        idv_attempts: row.idv_attempts ?? 0, idv_started_at: row.idv_started_at ?? null,
        idv_questions: row.idv_questions ?? null, idv_result: row.idv_result ?? null,
      };

      const q = await callVendor(cfg, "credit", "POST", "/Idv/getQuestions", {
        body: {
          idNumber: personId, idType: idvIdType(row), clientConsent: personId, noOfQuestions: 5,
          appName: APP_NAME, appVersion: APP_VERSION, extraData: { ref },
        },
        timeoutMs: 25_000, fetchImpl,
      });
      await log("credit", "POST", "/Idv/getQuestions", q);
      if (q.http === 401 || q.http === 403) return await configFailure(q, ["idv_in_progress"], beforeClaim);

      const transient = q.http === 0 || q.http === 408 || q.http === 429 || q.http >= 500;
      if (q.http !== 200 && !transient) {
        // A permanent rejection (e.g. 400 for this ID / ID type) will fail identically on every
        // retry — count the round and hand over, never loop the client on "try again".
        await transition(sb, ref, ["idv_in_progress"], {
          status: "idv_unavailable", idv_result: { vendorCode: q.vendorCode ?? `http_${q.http}`, vendorMessage: q.vendorMessage },
        }, `Identity questions refused by MortgageMax (${q.vendorCode ?? q.http})`);
        return ok({ status: "idv_unavailable" }, origin);
      }
      if (q.http !== 200) {
        // C4: a transient vendor failure (timeout, network, 408/429, 5xx) is not "no questions for
        // this ID". Return the row to where it was and do not count the round.
        const code = q.vendorCode ?? `http_${q.http}`;
        const back = await transition(sb, ref, ["idv_in_progress"], { ...beforeClaim, status: row.status },
          `Identity questions could not be fetched (${code}) — round not counted`);
        if (!back) return fail("invalid_state", "Identity check already started", origin);
        return fail("vendor_error", "We couldn't reach MortgageMAX just now. Please try again.", origin,
          { vendorCode: code, traceId: q.traceId });
      }
      if (!succeeded.getQuestions(q)) {
        // HTTP 200 without usable questions (T3 shape: thin file, unknown ID; or questions the form
        // cannot render) — never a dead end for the client.
        await transition(sb, ref, ["idv_in_progress"], {
          status: "idv_unavailable", idv_result: { vendorCode: q.vendorCode, vendorMessage: q.vendorMessage },
        }, "Identity questions unavailable for this ID");
        return ok({ status: "idv_unavailable" }, origin);
      }
      const d = q.data as { verificationRequestNumber: string; questions: unknown[] };
      await sb.from("credit_check_secrets").update({
        verification_request_number: d.verificationRequestNumber, updated_at: new Date().toISOString(),
      }).eq("ref", ref);
      const issued = await transition(sb, ref, ["idv_in_progress"], { idv_questions: d.questions }, "Identity questions issued");
      if (!issued) return fail("invalid_state", "Record changed during the identity check", origin);
      return ok({ status: "idv_in_progress", questions: d.questions }, origin); // never the VRN
    }

    // ======================================================================================
    if (action === "idv-expire") {
      // The client's 5:00 countdown ran out. Close the round now (instead of waiting for the 6-minute
      // server recovery) so the client keeps the retry they are entitled to.
      // A phone that slept past the server's window arrives AFTER recovery (or the sweep) already
      // expired the round — that is the outcome the client asked for, not an error.
      const alreadyExpired = row.idv_result && typeof row.idv_result === "object" && row.idv_result.expired === true;
      if (recovered === "idv_expired" || (row.status === "idv_failed" && alreadyExpired)) {
        return ok({ status: "idv_failed", canRetry: canRetry(), reason: "expired" }, origin);
      }
      if (row.status !== "idv_in_progress") {
        return fail("invalid_state", `No identity check in progress (status ${row.status})`, origin);
      }
      const vrn = secret.verification_request_number;
      if (vrn) {
        // Consume it conditionally: if answers already took it, they are with the vendor — let them finish.
        const { data: consumed } = await sb.from("credit_check_secrets")
          .update({ verification_request_number: null, updated_at: new Date().toISOString() })
          .eq("ref", ref).eq("verification_request_number", vrn).select("ref");
        if (!consumed || consumed.length === 0) return fail("invalid_state", "Identity check already submitted", origin);
      }
      const moved = await transition(sb, ref, ["idv_in_progress"], { status: "idv_failed", idv_result: { expired: true } },
        "Identity questions expired before they were answered");
      if (!moved) {
        // Lost a race with a concurrent recovery — if that expired it, report the same outcome.
        const { data: now } = await sb.from("credit_checks").select("status, idv_result, idv_attempts").eq("ref", ref).maybeSingle();
        if (now?.status === "idv_failed" && now.idv_result?.expired === true) {
          return ok({ status: "idv_failed", canRetry: (now.idv_attempts ?? 0) < MAX_IDV_ROUNDS, reason: "expired" }, origin);
        }
        return fail("invalid_state", "Record changed during the identity check", origin);
      }
      return ok({ status: "idv_failed", canRetry: canRetry(), reason: "expired" }, origin);
    }

    // ======================================================================================
    if (action === "idv-answer") {
      // C3: the answer window already closed (expired by recovery just now, or earlier) — say so.
      const expiredResult = row.idv_result && typeof row.idv_result === "object" && row.idv_result.expired === true;
      if (recovered === "idv_expired" || (row.status === "idv_failed" && expiredResult)) {
        return ok({ status: "idv_failed", canRetry: canRetry(), reason: "expired" }, origin);
      }
      if (row.status !== "idv_in_progress") {
        return fail("invalid_state", `No identity check in progress (status ${row.status})`, origin);
      }
      // Server-side time limit FIRST (the browser countdown is 5:00; allow a minute of slack), so a
      // client who ran out of time with partial answers still gets an answer, not a 400.
      const startedAt = row.idv_started_at ? new Date(row.idv_started_at).getTime() : 0;
      if (!startedAt || Date.now() - startedAt > IDV_ANSWER_WINDOW_MS) {
        await sb.from("credit_check_secrets").update({ verification_request_number: null, updated_at: new Date().toISOString() }).eq("ref", ref);
        await transition(sb, ref, ["idv_in_progress"], { status: "idv_failed", idv_result: { expired: true } },
          "Identity questions expired before they were answered");
        return ok({ status: "idv_failed", canRetry: canRetry(), reason: "expired" }, origin);
      }
      const questions = (Array.isArray(row.idv_questions) ? row.idv_questions : []) as Array<
        { questionNumber: string; possibleAnswers?: Array<{ value: string }> | null }
      >;
      const answers = body.answers as Array<{ questionNumber: string; answerNumber: string }>;
      if (!Array.isArray(answers) || answers.length !== questions.length) {
        return fail("bad_request", "Answer every question", origin);
      }
      const seen = new Set<string>();
      for (const qn of questions) {
        const a = answers.find((x) => x && x.questionNumber === qn.questionNumber);
        const options = Array.isArray(qn.possibleAnswers) ? qn.possibleAnswers : [];
        if (!a || seen.has(a.questionNumber) || !options.some((p) => p && p.value === a.answerNumber)) {
          return fail("bad_request", "Answer every question", origin);
        }
        seen.add(a.questionNumber);
      }

      // Real claim: atomically consume the session reference. A double-submit finds it gone → 409.
      const vrn = secret.verification_request_number;
      if (!vrn) return fail("invalid_state", "Identity check already submitted", origin);
      const { data: consumed } = await sb.from("credit_check_secrets")
        .update({ verification_request_number: null, updated_at: new Date().toISOString() })
        .eq("ref", ref).eq("verification_request_number", vrn).select("ref");
      if (!consumed || consumed.length === 0) return fail("invalid_state", "Identity check already submitted", origin);

      const res = await callVendor(cfg, "credit", "POST", "/Idv/checkAnswers", {
        body: {
          verificationRequestNumber: vrn,
          answers: answers.map((a) => ({ questionNumber: String(a.questionNumber), answerNumber: String(a.answerNumber) })),
          sourceSystem: SOURCE_SYSTEM,
        },
        timeoutMs: 25_000, fetchImpl,
      });
      await log("credit", "POST", "/Idv/checkAnswers", res);
      if (res.http === 401 || res.http === 403) return await configFailure(res, ["idv_in_progress"]);

      const d = (res.data ?? {}) as Record<string, unknown>;
      const idvResult = {
        success: d.success ?? null, statusCode: d.statusCode ?? null, responseStatus: d.responseStatus ?? null,
        finalScore: d.finalScore ?? null, errorCode: d.errorCode ?? null, vendorCode: res.vendorCode,
        http: res.http,
      };
      if (succeeded.checkAnswers(res)) {
        const passed = await transition(sb, ref, ["idv_in_progress"], {
          status: "idv_passed", idv_result: idvResult, idv_passed_at: new Date().toISOString(),
          verification_success_code: (d.statusCode as string) ?? null, // best inference; vendor to confirm
        }, "Identity verified");
        if (!passed) return fail("invalid_state", "Record changed during the identity check", origin);
        return ok({ status: "idv_passed" }, origin);
      }
      // C3: 'mismatch' only when the vendor actually scored the answers and said no.
      const reason = res.http === 200 && d.success === false && !res.vendorCode ? "mismatch" : "error";
      const failedRound = await transition(sb, ref, ["idv_in_progress"], { status: "idv_failed", idv_result: idvResult },
        reason === "mismatch" ? "Identity check not passed" : `Identity check could not be completed (${res.vendorCode ?? res.http})`);
      if (!failedRound) return fail("invalid_state", "Record changed during the identity check", origin);
      return ok({ status: "idv_failed", canRetry: canRetry(), reason }, origin);
    }

    return fail("bad_request", `Unknown action ${action}`, origin);
  } catch (e) {
    const msg = String(e instanceof Error ? e.message : e);
    console.error(JSON.stringify({ event: "mm_client_error", action, message: personId ? msg.split(personId).join("[redacted]") : msg }));
    if (msg.startsWith("config_error")) return fail("config_error", "Service is not configured", origin);
    return fail("server_error", "Something went wrong", origin);
  }
});
