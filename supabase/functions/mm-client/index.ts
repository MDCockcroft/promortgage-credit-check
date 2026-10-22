// mm-client — the ANONYMOUS-facing Edge Function (BUILD-PLAN D2, D14).
// Called by index.html. It can serve the consent wording, accept the application, register consent
// with MortgageMax, and run the identity-verification questions. It can NEVER run a credit check —
// that path exists only in mm-staff, behind a staff login.
//
// Authorisation: 'consent-types' and 'consultant' are public (neither is secret). Every other action
// needs { ref, idv_token }: submit_application minted the token once (32 random bytes); only its
// sha256 is stored, with a 30-minute expiry, in credit_check_secrets (unreadable by any client role).
// A consultant can re-issue it (mm-staff 'reissue-idv-link', 24-hour expiry), which replaces the hash.
// Deploy with --no-verify-jwt: the project's publishable key is not a JWT.
//
// There is no SMS code (MortgageMAX, Bennie Vermeulen, 2026-10-12: the identity questions alone
// verify the person). 'submit' creates the application already in consent_confirmed and hands the
// token straight back; the browser then calls 'register-consent' and 'idv-start'.
//
// POST { action: 'consent-types' }
// POST { action: 'consultant', code }               → { name } (first name for a personal link, or null)
// POST { action: 'submit', payload, consultant_code } → { ref, idv_token }
// POST { ref, idv_token, action: 'register-consent' | 'idv-start' | 'idv-answer' | 'idv-expire', answers? }
// POST { ref, idv_token, action: 'id-upload-url', side: 'front' | 'back', contentType } → one-time upload URL
// POST { ref, idv_token, action: 'id-attach', front, back? }  → the client's own ID copy on the record

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { fail, ok, preflight } from "../_shared/http.ts";
import { type Api, callVendor, configFromEnv, IDV_LIMIT_CODE, idvPassScore, type MmConfig, succeeded, type VendorResult } from "../_shared/mmax.ts";
import { logCall, serviceClient, sha256Hex, transition } from "../_shared/db.ts";
import { mockFetch } from "../_shared/mock.ts";
import { type Ctx, idvModeFromEnv, type Mode, publicConsentTypes, registerConsent } from "../_shared/register.ts";
import { recoverStale } from "../_shared/recover.ts";
import { idvIdType, personIdFor } from "../_shared/idnumber.ts";
import { IDV_ANSWER_WINDOW_MS, MAX_IDV_ROUNDS } from "../_shared/states.ts";
import { isMissingFunction, validLinkCode } from "../_shared/access.ts";
import { productionStopped, STOPPED } from "../_shared/stop.ts";
import {
  clientIdCopyCheck, ID_DOC_BUCKET, ID_DOC_MAX_BYTES, ID_DOC_TYPES, idBackPath, idCopyPath, sha256HexBytes, sniffDocType,
  validIdBackPath, validIdCopyPath,
} from "../_shared/manual.ts";

const APP_NAME = "promortgage-credit-check";
const APP_VERSION = "2026.09.26";
const SOURCE_SYSTEM = "PMSA-CreditCheck";
// C5: identity-question rounds per ID number across ALL records, rolling 24 h. Stops anyone from
// harvesting a person's credit-file facts (or running up IDV calls) by submitting fresh forms.
// 2 = MortgageMAX's production cooldown (Louis Pires, 2026-09-30): identity questions at most twice
// per 24 hours. A third round would only be refused by the vendor, so hand over to manual first.
const MAX_IDV_ROUNDS_PER_PERSON_24H = 2;
// submit_application's own refusals — safe to pass to the form as codes (it maps them to copy).
// The client's own ID copy: how many of their objects (front / back, including abandoned uploads) one
// record may hold before further upload URLs are refused — a brake on anonymous uploads.
const CLIENT_UPLOAD_SLOTS = 6;
const SUBMIT_REFUSALS = new Set([
  "invalid_id_number", "invalid_passport_number", "invalid_id_type", "invalid_cell", "too_many_submissions",
  "too_many_applications", "consent_required", "consultant_link_required",
]);

Deno.serve(async (req) => {
  const origin = req.headers.get("Origin");
  if (req.method === "OPTIONS") return preflight(origin);
  if (req.method !== "POST") return fail("bad_request", "POST only", origin);

  let body: {
    ref?: string; idv_token?: string; action?: string; answers?: unknown; payload?: unknown;
    code?: unknown; consultant_code?: unknown; side?: unknown; contentType?: unknown; front?: unknown; back?: unknown;
  };
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

  // The emergency stop (_shared/stop.ts): in production nothing talks to the vendor, and no new
  // application is accepted, while MM_MODE is not live. The consultant lookup and idv-expire are
  // local and stay available.
  const stopped = productionStopped(mode);
  if (stopped && ["consent-types", "submit", "register-consent", "idv-start", "idv-answer"].includes(action)) {
    console.error(JSON.stringify({ event: "stopped_in_production", action, mode }));
    return fail(STOPPED.code, STOPPED.message, origin);
  }

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

  // ---- public: whose personal link is this? (first name only; null for an unknown code) ------
  if (action === "consultant") {
    if (!validLinkCode(body.code)) return ok({ name: null }, origin);
    const c = await sb.rpc("consultant_by_code", { p_code: body.code });
    if (c.error) {
      console.error(JSON.stringify({
        event: "consultant_lookup_failed", message: isMissingFunction(c.error) ? "roles_not_installed" : c.error.message,
      }));
      return ok({ name: null }, origin);
    }
    return ok({ name: typeof c.data === "string" && c.data ? c.data : null }, origin);
  }

  // ---- retired actions (remove after 2026-11-01) -------------------------------------------------
  // A form page cached before the 12 Oct push still shows the SMS screen after submitting (the
  // application IS recorded, in consent_confirmed). Answer its two calls with the copy that page
  // already has for "your consent is recorded; your consultant will contact you", so the client is
  // not told to retry or to submit again (each resubmission would be another application).
  if (action === "confirm") return ok({ ok: false, ref: ref ?? null, error: "already_confirmed", idv_token: null }, origin);
  if (action === "resend-otp") return ok({ sent: false, reason: "invalid_state" }, origin);

  // ---- the form --------------------------------------------------------------------------------
  // The browser never calls the database itself. submit_application (migration 20261005) validates
  // the payload, creates the record already in consent_confirmed and mints the one-time identity-
  // check token in the same transaction. The token goes back to this browser once.
  if (action === "submit") {
    try {
      const p = body.payload;
      if (!p || typeof p !== "object" || Array.isArray(p)) return fail("bad_request", "payload is required", origin);
      // Applications arrive only through an active consultant's personal link (Michael, 2026-10-01):
      // the bare address is the staff sign-in, and there is no general form any more. Checked BEFORE
      // the record is made, so a stale or made-up code leaves nothing behind. (The page hides the
      // form in the same cases; this is the control.)
      if (!validLinkCode(body.consultant_code)) return fail("bad_request", "consultant_link_required", origin);
      const who = await sb.rpc("consultant_by_code", { p_code: body.consultant_code });
      if (who.error) throw new Error(`server_error: ${who.error.message}`);
      if (typeof who.data !== "string" || !who.data) return fail("bad_request", "consultant_link_required", origin);

      // submit_application checks the link again, the consent flag, and the caps (per person and
      // link, per link, and the daily breaker) under its own locks - see migration 20261005.
      const sub = await sb.rpc("submit_application", { payload: p, p_consultant_code: body.consultant_code });
      if (sub.error) {
        const m = sub.error.message ?? "";
        if (SUBMIT_REFUSALS.has(m)) return fail("bad_request", m, origin);
        if (isMissingFunction(sub.error)) {
          // Migration 20261005 not applied yet: nothing was written. Never silent.
          console.error(JSON.stringify({ event: "submit_application_missing" }));
          return fail("config_error", "Service is not configured", origin);
        }
        throw new Error(`server_error: ${m}`);
      }
      const d = sub.data as { ref: string; idv_token: string };
      // The record belongs to that consultant. If they were deactivated in the instant since the
      // check above, it stays unassigned for an administrator to hand out (and is logged below).
      const at = await sb.rpc("attach_consultant", { p_ref: d.ref, p_code: body.consultant_code });
      // Never silent: every application that arrives through a link but lands unassigned is logged
      // (the database also notes an inactive link on the record itself).
      if (at.error) {
        console.error(JSON.stringify({
          event: "attach_consultant_failed", ref: d.ref,
          message: isMissingFunction(at.error) ? "roles_not_installed" : at.error.message,
        }));
      } else if (at.data !== true) {
        // A mistyped, old or deactivated link: worth seeing, not an error.
        console.warn(JSON.stringify({ event: "attach_consultant_not_attached", ref: d.ref }));
      }
      return ok({ ref: d.ref, idv_token: d.idv_token }, origin);
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
  const log = (api: Api, method: string, path: string, result: VendorResult) =>
    logCall(sb, { ref, requestId, api, method, path, result, redactValues: [personId, row.mm_person_id, row.cell, row.email], env: cfg.env });
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
    // The client's own ID copy (Michael, 2026-10-20, late): optional on the form — the front, and the
    // back of a smart ID card or driver's licence as a second picture. Uploaded through one-time signed
    // URLs for paths WE choose, then checked byte by byte before anything counts. It is the ID copy every
    // record needs before a credit check (migration 20261008); the consultant may replace it. ONE attach
    // per application, only while it is still the client's turn (manual.ts clientIdCopyCheck; the
    // database refuses the same way) — so a copy a consultant has opened cannot be swapped under them.
    if (action === "id-upload-url") {
      const side = body.side === "front" || body.side === "back" ? body.side : null;
      if (!side) return fail("bad_request", "side must be front or back", origin);
      const can = clientIdCopyCheck(row);
      if (!can.ok) return fail("invalid_state", can.reason, origin);
      const contentType = String(body.contentType ?? "");
      const path = side === "front" ? idCopyPath(ref, contentType) : idBackPath(ref, contentType);
      if (!path) return fail("bad_request", "The ID copy must be a PDF, JPG or PNG", origin);
      // A brake on anonymous uploads: a record holds at most CLIENT_UPLOAD_SLOTS of the client's own
      // objects (a front and a back, plus a retry or two — abandoned uploads count until the record is
      // deleted). Beyond that no URL is issued.
      const { data: objects, error: listErr } = await sb.storage.from(ID_DOC_BUCKET).list(ref, { limit: 100 });
      if (listErr) {
        console.error(JSON.stringify({ event: "client_id_doc_list_failed", ref, message: listErr.message }));
        return fail("server_error", "Could not prepare the upload", origin);
      }
      const mine = (objects ?? []).filter((o) => /^id(copy|back)-/.test(String(o?.name ?? ""))).length;
      if (mine >= CLIENT_UPLOAD_SLOTS) return fail("invalid_state", "too_many_uploads", origin);
      const { data: up, error: upErr } = await sb.storage.from(ID_DOC_BUCKET).createSignedUploadUrl(path);
      if (upErr || !up) return fail("server_error", "Could not prepare the upload", origin);
      return ok({ path: up.path, token: up.token, maxBytes: ID_DOC_MAX_BYTES }, origin);
    }

    if (action === "id-attach") {
      const front = body.front;
      const back = body.back == null || body.back === "" ? null : body.back;
      if (!validIdCopyPath(ref, front)) return fail("bad_request", "Upload the front of the ID first", origin);
      if (back !== null && !validIdBackPath(ref, back)) return fail("bad_request", "The back of the ID was not uploaded", origin);
      const uploaded: string[] = back === null ? [front] : [front, back];
      const current = (r: Record<string, unknown> | null | undefined) =>
        [r?.id_document_path, r?.id_document_back_path].filter((p): p is string => typeof p === "string" && !!p);
      // The same call again (a retry after a lost response): the copy is there — say so, touch nothing.
      if (row.id_document_path === front && (row.id_document_back_path ?? null) === back) {
        return ok({
          idDocument: { path: front, type: row.id_document_type, bytes: row.id_document_bytes, sha256: row.id_document_sha256 },
          idDocumentBack: back ? { path: back, type: row.id_document_back_type, bytes: row.id_document_back_bytes, sha256: row.id_document_back_sha256 } : null,
        }, origin);
      }
      // A refused or failed attach discards the uploads — but NEVER a file the record points at (a replayed
      // call naming the committed paths must not remove the evidence). Re-read, so a concurrent attach counts.
      const discard = async () => {
        const { data: now } = await sb.from("credit_checks").select("id_document_path, id_document_back_path").eq("ref", ref).maybeSingle();
        const keep = new Set([...current(row), ...current(now)]);
        const doomed = uploaded.filter((p) => !keep.has(p));
        if (!doomed.length) return;
        const rm = await sb.storage.from(ID_DOC_BUCKET).remove(doomed);
        if (rm.error) console.error(JSON.stringify({ event: "client_id_doc_discard_failed", ref, message: rm.error.message }));
      };
      const can = clientIdCopyCheck(row);
      if (!can.ok) { await discard(); return fail("invalid_state", can.reason, origin); }
      // Each file must really be there, within the limit, and of the type its name claims. A storage
      // fault is ours (server_error, logged), never blamed on the file.
      type Inspected = { ok: true; type: string; bytes: number; sha256: string } | { ok: false; storage: boolean };
      const inspect = async (path: string): Promise<Inspected> => {
        const { data: blob, error: dlErr } = await sb.storage.from(ID_DOC_BUCKET).download(path);
        if (dlErr) {
          const status = String((dlErr as { statusCode?: unknown }).statusCode ?? "");
          const missing = status === "404" || /not found/i.test(dlErr.message ?? "");
          if (!missing) console.error(JSON.stringify({ event: "client_id_doc_download_failed", ref, message: dlErr.message }));
          return { ok: false, storage: !missing };
        }
        if (!blob) return { ok: false, storage: false };
        const bytes = new Uint8Array(await blob.arrayBuffer());
        if (bytes.length === 0 || bytes.length > ID_DOC_MAX_BYTES) return { ok: false, storage: false };
        const type = sniffDocType(bytes);
        if (!type || ID_DOC_TYPES[type] !== path.split(".").pop()) return { ok: false, storage: false };
        return { ok: true, type, bytes: bytes.length, sha256: await sha256HexBytes(bytes) };
      };
      const badFile = (side: string) => fail("bad_request", `The ${side} of the ID is missing, empty, over 10 MB or not a readable PDF, JPG or PNG`, origin);
      const f = await inspect(front);
      if (!f.ok) { await discard(); return f.storage ? fail("server_error", "Could not read the upload", origin) : badFile("front"); }
      const b = back === null ? null : await inspect(back);
      if (b && !b.ok) { await discard(); return b.storage ? fail("server_error", "Could not read the upload", origin) : badFile("back"); }
      const bk = b && b.ok ? b : null;
      const { error: rpcErr } = await sb.rpc("attach_id_copy_client", {
        p_ref: ref, p_front_path: front, p_front_type: f.type, p_front_bytes: f.bytes, p_front_sha256: f.sha256,
        p_back_path: back, p_back_type: bk?.type ?? null, p_back_bytes: bk?.bytes ?? null, p_back_sha256: bk?.sha256 ?? null,
      });
      if (rpcErr) {
        await discard();
        const m = rpcErr.message ?? "";
        const refused = (m.match(/id_copy_(busy|locked|present)/) ?? [])[0];
        if (refused) return fail("invalid_state", refused, origin);
        if (isMissingFunction(rpcErr)) {
          // Migration 20261009 not applied yet: nothing was written. Never silent.
          console.error(JSON.stringify({ event: "attach_id_copy_client_missing" }));
          return fail("config_error", "Service is not configured", origin);
        }
        throw new Error(`server_error: ${m}`);
      }
      return ok({
        idDocument: { path: front, type: f.type, bytes: f.bytes, sha256: f.sha256 },
        idDocumentBack: bk ? { path: back, type: bk.type, bytes: bk.bytes, sha256: bk.sha256 } : null,
      }, origin);
    }

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
          idNumber: personId, idType: idvIdType(row), clientConsent: "Y", noOfQuestions: 5,
          appName: APP_NAME, appVersion: APP_VERSION, extraData: { ref },
        },
        timeoutMs: 25_000, fetchImpl,
      });
      await log("credit", "POST", "/Idv/getQuestions", q);
      if (q.http === 401 || q.http === 403) return await configFailure(q, ["idv_in_progress"], beforeClaim);

      // MortgageMAX's global limit (twice per 24 hours per ID number, across all its systems). Checked
      // before the transient test: if it ever comes as a 429, "try again" would only loop the client.
      // The round stays counted; the consultant verifies manually (idv_unavailable).
      if (q.vendorCode === IDV_LIMIT_CODE) {
        await transition(sb, ref, ["idv_in_progress"], {
          status: "idv_unavailable", idv_result: { vendorCode: q.vendorCode, vendorMessage: q.vendorMessage },
        }, "Identity questions refused: MortgageMAX allows them twice per 24 hours per ID number, across all its systems");
        return ok({ status: "idv_unavailable" }, origin);
      }

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
      if (succeeded.checkAnswers(res, idvPassScore(Deno.env.get("MM_IDV_PASS_SCORE")))) {
        const passed = await transition(sb, ref, ["idv_in_progress"], {
          status: "idv_passed", idv_result: idvResult, idv_passed_at: new Date().toISOString(),
          // Vendor-confirmed (2026-09-29): /CreditCheck/full's verificationSuccessCode is the
          // verificationRequestNumber of the PASSED session. It is spent (consumed above), so it can
          // no longer answer questions; it lives on the staff-only record for the credit check.
          verification_success_code: vrn,
        }, "Identity verified");
        if (!passed) return fail("invalid_state", "Record changed during the identity check", origin);
        return ok({ status: "idv_passed" }, origin);
      }
      // C3: 'mismatch' only when the vendor actually scored the answers and said no — an explicit
      // success:false, or a status other than the pass status.
      // (A scored check that fell short of the pass mark arrives as success:true + "TSCR" + a low score.)
      const scored = d.success === false || (typeof d.statusCode === "string" && d.statusCode.trim() !== "");
      const reason = res.http === 200 && scored && !res.vendorCode ? "mismatch" : "error";
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
