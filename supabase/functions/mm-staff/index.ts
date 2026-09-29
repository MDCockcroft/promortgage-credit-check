// mm-staff — the STAFF-ONLY Edge Function (BUILD-PLAN D2, D8, D9).
// The only code path that can run a (billable) credit check. Caller must be a signed-in staff user.
//
// Auth: deployed with --no-verify-jwt because this project signs session tokens with the new key
// system; the function verifies the bearer itself via auth.getUser() — that call is authoritative.
// Any authenticated user is staff (matches RLS staff_all; public sign-ups are disabled).
//
// POST { action: 'config' }
// POST { ref, action: 'run-check' | 'fetch-pdf' | 'refresh-consents' | 'record-withdrawal' | 'register-consent'
//              | 'delete-record' | 'recover' | 'clear-config-error', reason? }
// POST { ref, action: 'manual-upload-url', contentType }            → one-time upload URL for the ID copy
// POST { ref, action: 'manual-verify', path, attestationVersion, attested: true } → manual_verified
// POST { ref, action: 'reissue-idv-link' }                          → { token, expiresAt } (shown once)
// Administrators only:
// POST { ref, action: 'assign', consultantId }                      → { status: 'ok' }
// POST { action: 'staff-list' }                                     → { staff: [...] }
// POST { action: 'staff-save', userId, role, active }               → { member }
//
// Roles (migration 20260930, _shared/access.ts): a consultant may act only on records assigned to
// them; a record that is not theirs is answered exactly like one that does not exist.
//
// Every action with a ref first runs the stale-state recovery (C1, _shared/recover.ts).

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { fail, ok, preflight } from "../_shared/http.ts";
import { callVendor, configFromEnv, type MmConfig, succeeded, type VendorResult } from "../_shared/mmax.ts";
import {
  buildWithdrawConsents,
  consentGrantState,
  configuredTypeIds,
  contextFor,
  declarationHash,
  type WithdrawItem,
} from "../_shared/consents.ts";
import { type Ctx, idvModeFromEnv, loadConfiguredTypes, type Mode, registerConsent } from "../_shared/register.ts";
import { logCall, serviceClient, sha256Hex, transition } from "../_shared/db.ts";
import { mockFetch } from "../_shared/mock.ts";
import { base64ToBytes, num, pdfIsEncrypted, summarise } from "../_shared/report.ts";
import { recoverStale } from "../_shared/recover.ts";
import { personIdFor } from "../_shared/idnumber.ts";
import { accessFor, isMissingFunction, loadMember, type Member } from "../_shared/access.ts";
import {
  ATTESTATION,
  ID_DOC_BUCKET,
  ID_DOC_MAX_BYTES,
  ID_DOC_TYPES,
  idDocPath,
  manualVerifyCheck,
  sha256HexBytes,
  sniffDocType,
  validIdDocPath,
} from "../_shared/manual.ts";

const APP_NAME = "promortgage-credit-check";
const APP_VERSION = "2026.09.26";
const SOURCE_SYSTEM = "PMSA-CreditCheck";
const BUSINESS_GROUP = "MortgageMAX";
const BUSINESS_NAME = "Pro Mortgages SA";
const DEFAULT_TERM_MONTHS = 240; // standard 20-year bond; the form does not collect a term yet
const WALL_CLOCK_BUDGET_MS = 140_000;     // Edge Function hard limit is 150 s — keep headroom
const CREDIT_TIMEOUT_MS = 90_000;
const PDF_TIMEOUT_MS = 60_000;
const CONSENT_READ_TIMEOUT_MS = 15_000;   // pre-check read-back; 15 s + 90 s stays inside the budget
const PDF_FETCH_STALE_MS = 3 * 60 * 1000; // a PDF still "fetching" this long after the report is dead
const UNCERTAIN_TEXT = "MortgageMAX may still have processed this enquiry — check before retrying";
/** record-withdrawal is refused from these (C8). */
const NO_WITHDRAWAL_FROM = ["awaiting_otp", "consent_withdrawn", "check_in_flight"];

import {
  ALL_STATUSES,
  allowedFrom,
  configErrorTarget,
  IDV_LINK_TTL_MS,
  idvLinkCheck,
  type IdvMode,
} from "../_shared/states.ts";

Deno.serve(async (req) => {
  const origin = req.headers.get("Origin");
  if (req.method === "OPTIONS") return preflight(origin);
  if (req.method !== "POST") return fail("bad_request", "POST only", origin);

  let cfg: MmConfig;
  let sb: SupabaseClient;
  try {
    cfg = configFromEnv();
    sb = serviceClient();
  } catch (e) {
    console.error(JSON.stringify({ event: "config_error", message: String(e) }));
    return fail("config_error", "Service is not configured", origin);
  }

  // ---- authenticate staff ---------------------------------------------------------------
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt || jwt.startsWith("sb_")) return fail("unauthenticated", "Sign in required", origin);
  const { data: auth, error: authErr } = await sb.auth.getUser(jwt);
  if (authErr || !auth?.user) return fail("unauthenticated", "Sign in required", origin);
  const user = auth.user;

  let body: {
    ref?: string; action?: string; reason?: string;
    contentType?: string; path?: string; attestationVersion?: string; attested?: boolean;
    consultantId?: string; userId?: string; role?: string; active?: boolean;
  };
  try {
    body = await req.json();
  } catch {
    return fail("bad_request", "Body must be JSON", origin);
  }
  const { ref, action } = body;
  if (!action) return fail("bad_request", "action is required", origin);

  // ---- who is this, and may they? ---------------------------------------------------------
  let member: Member | null;
  try {
    member = await loadMember(sb, user.id);
  } catch (e) {
    console.error(JSON.stringify({ event: "mm_staff_error", action, message: String(e instanceof Error ? e.message : e) }));
    return fail("server_error", "Something went wrong", origin);
  }
  if (!member) return fail("forbidden", "account_inactive", origin);
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  if (action === "staff-list" || action === "staff-save") {
    if (accessFor(member, action, user.id) !== "ok") return fail("forbidden", "admin_only", origin);
    if (member.legacy) return fail("invalid_state", "roles_not_installed", origin);
    try {
      if (action === "staff-save") {
        if (!UUID.test(String(body.userId ?? "")) || (body.role !== "admin" && body.role !== "consultant") || typeof body.active !== "boolean") {
          return fail("bad_request", "userId, role and active are required", origin);
        }
        const known = await sb.auth.admin.getUserById(body.userId as string);
        if (known.error || !known.data?.user) return fail("bad_request", "No such login", origin);
        const up = await sb.rpc("upsert_staff_member", { p_user: body.userId, p_role: body.role, p_active: body.active, p_by: user.id });
        if (up.error) {
          if (/last_admin/.test(up.error.message ?? "")) return fail("invalid_state", "last_admin", origin);
          throw new Error(`server_error: ${up.error.message}`);
        }
        console.log(JSON.stringify({ event: "staff_saved", by: user.id, user: body.userId, role: body.role, active: body.active }));
        const m = up.data as Record<string, unknown>;
        return ok({ member: { userId: m.user_id, role: m.role, active: m.active, linkCode: m.link_code } }, origin);
      }
      // staff-list: every login, with its role if it has one (a login without one can see nothing).
      const users = await sb.auth.admin.listUsers({ page: 1, perPage: 200 });
      if (users.error) throw new Error(`server_error: ${users.error.message}`);
      const [members, profiles, owned] = await Promise.all([
        sb.from("staff_members").select("user_id, role, active, link_code"),
        sb.from("staff_profiles").select("user_id, full_name"),
        sb.from("credit_checks").select("consultant_id").not("consultant_id", "is", null),
      ]);
      for (const q of [members, profiles, owned]) if (q.error) throw new Error(`server_error: ${q.error.message}`);
      const by = <T extends { user_id: string }>(rows: T[] | null) => new Map((rows ?? []).map((r) => [r.user_id, r]));
      const mm = by(members.data as Array<{ user_id: string; role: string; active: boolean; link_code: string | null }>);
      const pp = by(profiles.data as Array<{ user_id: string; full_name: string }>);
      const counts = new Map<string, number>();
      for (const r of (owned.data ?? []) as Array<{ consultant_id: string }>) counts.set(r.consultant_id, (counts.get(r.consultant_id) ?? 0) + 1);
      const staff = users.data.users.map((u) => ({
        userId: u.id, email: u.email ?? "", fullName: pp.get(u.id)?.full_name ?? "",
        role: mm.get(u.id)?.role ?? null, active: mm.get(u.id)?.active ?? false,
        linkCode: mm.get(u.id)?.link_code ?? null, clients: counts.get(u.id) ?? 0, isMe: u.id === user.id,
      })).sort((a, b) => (a.fullName || a.email).localeCompare(b.fullName || b.email));
      return ok({ staff }, origin);
    } catch (e) {
      console.error(JSON.stringify({ event: "mm_staff_error", action, message: String(e instanceof Error ? e.message : e) }));
      return fail("server_error", "Something went wrong", origin);
    }
  }

  if (action === "config") {
    // What admin.html needs to render the right controls — including the attestation wording, so
    // the page shows exactly the text the server will store.
    return ok({
      mode: Deno.env.get("MM_MODE") === "live" ? "live" : "mock",
      idvMode: idvModeFromEnv(),
      env: cfg.env,
      allowPassport: Deno.env.get("ALLOW_PASSPORT") === "true",
      attestation: ATTESTATION,
      idDocument: { maxBytes: ID_DOC_MAX_BYTES, types: Object.keys(ID_DOC_TYPES) },
      // roles: false until migration 20260930 is applied (then everyone behaves as an administrator)
      me: { userId: user.id, role: member.role, linkCode: member.linkCode, roles: !member.legacy },
    }, origin);
  }
  if (!ref) return fail("bad_request", "ref and action are required", origin);

  const { data: row } = await sb.from("credit_checks").select("*").eq("ref", ref).maybeSingle();
  if (!row) return fail("bad_request", "No such record", origin);
  const access = accessFor(member, action, user.id, row);
  // A colleague's record is answered exactly like a missing one: its existence is not this user's business.
  if (access === "not_yours") return fail("bad_request", "No such record", origin);
  if (access !== "ok") return fail("forbidden", access === "admin_only" ? "admin_only" : "account_inactive", origin);

  const mode: Mode = Deno.env.get("MM_MODE") === "live" ? "live" : "mock";
  const idvMode: IdvMode = idvModeFromEnv();
  const fetchImpl = mode === "mock" ? mockFetch : undefined;
  // The number sent to MortgageMAX is the one id_type names (C6b); mm_person_id is redacted too.
  const personId: string = personIdFor(row);
  const requestId = crypto.randomUUID();
  const staffLabel = user.email ?? user.id;
  const log = (api: "credit" | "consent", method: string, path: string, result: VendorResult) =>
    logCall(sb, { ref, requestId, api, method, path, result, redactValues: [personId, row.mm_person_id], env: cfg.env });

  const ctx: Ctx = { sb, cfg, mode, fetchImpl, log };
  const startedAtMs = Date.now();

  try {
    // C1: a check left "running" past the stale window, or identity questions left unanswered past
    // the answer window, are recovered before ANY action — never auto-retried (the bureau may
    // already have processed and billed a check).
    await recoverStale(sb, row);

    // ======================================================================================
    if (action === "assign") {
      // Administrator only (accessFor). The database function enforces the rule that clients do
      // not move: only an unassigned record, or one whose consultant is no longer active.
      if (!UUID.test(String(body.consultantId ?? ""))) return fail("bad_request", "consultantId is required", origin);
      const a = await sb.rpc("assign_consultant", { p_ref: ref, p_consultant: body.consultantId, p_by: user.id, p_by_label: staffLabel });
      if (a.error) {
        if (isMissingFunction(a.error)) return fail("invalid_state", "roles_not_installed", origin);
        throw new Error(`server_error: ${a.error.message}`);
      }
      if (a.data === "ok") return ok({ status: "ok" }, origin);
      if (a.data === "not_found") return fail("bad_request", "No such record", origin);
      return fail("invalid_state", `assign_${String(a.data)}`, origin); // assign_not_staff | assign_already_assigned
    }

    // ======================================================================================
    if (action === "recover") return ok({ status: row.status }, origin);

    // ======================================================================================
    if (action === "clear-config-error") {
      // C2: only after the credential problem is fixed. The target is derived from the row's own
      // data, so a record can never be released into a state it never reached.
      if (row.status !== "config_error") {
        return fail("invalid_state", `No system error to clear (status ${row.status})`, origin);
      }
      const target = configErrorTarget(row, idvMode);
      const moved = await transition(sb, ref, ["config_error"], { ...target.patch, status: target.status },
        `System error cleared by ${staffLabel}`);
      if (!moved) return fail("invalid_state", "Record changed — reload and try again", origin);
      return ok({ status: target.status }, origin);
    }

    // ======================================================================================
    if (action === "register-consent") {
      // Consultant retry: the client's 30-minute session expired or MortgageMax was unavailable.
      const out = await registerConsent(ctx, row, staffLabel);
      if (!out.ok) return fail(out.code, out.message, origin, { vendorCode: out.vendorCode, traceId: out.traceId });
      return ok({ status: out.status, idvMode: out.idvMode, reason: out.reason }, origin);
    }

    // ======================================================================================
    if (action === "run-check") {
      if (!personId) return fail("bad_request", "No ID number on record", origin);
      const from = allowedFrom(idvMode);
      if (!from.includes(row.status)) {
        return fail("invalid_state", `A credit check cannot run from status ${row.status}`, origin);
      }

      // A withdrawal recorded on ANY application for this person stops paid checks on all of them —
      // even if MortgageMAX still shows granted (vendor refused the withdrawal, or it was local-only).
      if (row.mm_person_id) {
        const { data: siblings } = await sb.from("credit_checks").select("ref")
          .eq("mm_person_id", row.mm_person_id).eq("status", "consent_withdrawn").neq("ref", ref).limit(1);
        if (Array.isArray(siblings) && siblings.length > 0) {
          return fail("invalid_state", "withdrawn_elsewhere", origin);
        }
      }

      // C7 / D6: the vendor consent is replace-on-write per (personId, type) — re-read it right
      // before the paid call. No state change on any failure here: nothing has been sent.
      const typeIds = configuredTypeIds(Deno.env.get("MM_CONSENT_TYPES"));
      const pre = await callVendor(cfg, "consent", "GET", "/Consents", {
        query: { PersonId: personId }, timeoutMs: CONSENT_READ_TIMEOUT_MS, fetchImpl,
      });
      await log("consent", "GET", "/Consents", pre);
      if (pre.http === 401 || pre.http === 403) {
        return fail("config_error", "MortgageMax rejected our credentials — contact your developer", origin);
      }
      if (pre.http !== 200 || !Array.isArray(pre.data)) {
        return fail("vendor_error", "Could not confirm the consent with MortgageMAX — no credit check was sent", origin,
          { vendorCode: pre.vendorCode, traceId: pre.traceId });
      }
      if (!consentGrantState(pre.data, typeIds).allGranted) {
        return fail("invalid_state", "consent_not_granted", origin);
      }

      // Atomic claim BEFORE the paid call (D9): zero rows → someone else got there first.
      const claimed = await transition(sb, ref, from, {
        status: "check_in_flight",
        check_started_at: new Date().toISOString(),
        check_request_id: requestId,
        check_attempt: (row.check_attempt ?? 0) + 1,
        check_requested_by: user.id,
        check_error_code: null,
        check_error_text: null,
        mm_consents_snapshot: pre.data,
        mm_consents_synced_at: new Date().toISOString(),
      }, row.manual_verified_at && !row.idv_passed_at
        ? `Credit check requested by ${staffLabel} (identity verified manually)`
        : `Credit check requested by ${staffLabel}`);
      if (!claimed) {
        return fail("invalid_state", `A credit check cannot run from status ${row.status}`, origin);
      }

      const { data: prof } = await sb.from("staff_profiles").select("*").eq("user_id", user.id).maybeSingle();
      const [fn, ...ln] = String(prof?.full_name ?? user.user_metadata?.full_name ?? staffLabel.split("@")[0]).split(" ");

      const gross = num(row.gross_income) ?? 0;
      const deductions = num(row.total_deductions) ?? 0;
      const request: Record<string, unknown> = {
        firstName: row.first_names,
        lastName: row.surname,
        idNumber: personId,
        sourceSystem: SOURCE_SYSTEM,
        // Spec bug: address/userDetails $ref themselves — real shapes are UserAddress / UserData.
        address: {
          addressType: "Residential",
          line1: row.street, suburb: row.suburb, city: row.city, province: row.province,
          country: "South Africa", postalCode: row.postal_code,
          captureDate: new Date(row.created_at).toISOString(),
        },
        returnPdfAsBase64: false,
        cellPhoneNumber: row.cell,
        workPhoneNumber: row.work_phone ?? "",
        emailAddress: row.email,
        // Non-nullable numerics: always numbers, never null (trap).
        grossIncome: gross,
        nettIncome: Math.max(gross - deductions, 0),
        expenses: num(row.monthly_expenses) ?? 0,
        idConcent: personId, // vendor spelling; best inference = personId (vendor email confirms)
        totalBondRepayment: num(row.housing_payment) ?? 0,
        totalBondRepaymentToBeSettled: 0,
        repaymentTerm: DEFAULT_TERM_MONTHS,
        appVersion: APP_VERSION,
        appName: APP_NAME,
        extraData: { ref },
        isCreditCheckOnMyself: false,
        consentWasGiven: true,
        userDetails: {
          userFirstName: fn, userLastName: ln.join(" "), userIdNumber: "",
          userEmailAddress: prof?.email ?? user.email ?? "", userWorkPhoneNumber: "",
          userCellPhoneNumber: prof?.cell ?? "", businessGroupName: BUSINESS_GROUP,
          businessName: BUSINESS_NAME, businessBranchName: prof?.branch_name ?? "",
        },
      };
      if (row.verification_success_code) request.verificationSuccessCode = row.verification_success_code;

      let res: VendorResult;
      try {
        res = await callVendor(cfg, "credit", "POST", "/CreditCheck/full", { body: request, timeoutMs: CREDIT_TIMEOUT_MS, fetchImpl });
        await log("credit", "POST", "/CreditCheck/full", res);
      } catch (e) {
        // Defence in depth: never leave a claimed, possibly billed check in check_in_flight.
        await transition(sb, ref, ["check_in_flight"], {
          status: "check_failed", check_error_code: "uncertain_exception", check_error_text: UNCERTAIN_TEXT,
        }, `Credit check did not complete — ${UNCERTAIN_TEXT}`);
        throw e;
      }

      if (res.http === 401 || res.http === 403) {
        // check_started_at is set → clear-config-error moves this to check_failed (C2).
        await transition(sb, ref, ["check_in_flight"], { status: "config_error", check_error_code: `http_${res.http}` },
          "MortgageMax rejected our credentials");
        return fail("config_error", "MortgageMax rejected our credentials — contact your developer", origin);
      }
      if (!succeeded.creditFull(res)) {
        // C7: no response (any network error or timeout) or a 5xx = outcome unknown — the enquiry
        // may have been billed and footprinted. Never auto-retry; the consultant checks first.
        const uncertain = res.http === 0 || res.http >= 500;
        const code = uncertain ? `uncertain_${res.vendorCode ?? res.http}` : (res.vendorCode ?? `http_${res.http}`);
        await transition(sb, ref, ["check_in_flight"], {
          status: "check_failed", check_error_code: code,
          check_error_text: uncertain ? UNCERTAIN_TEXT : (res.vendorMessage?.slice(0, 500) ?? null),
        }, uncertain
          ? `Credit check did not complete (${res.vendorCode ?? res.http}) — ${UNCERTAIN_TEXT}`
          : `Credit check failed (${code})`);
        return fail(uncertain ? "vendor_timeout" : "vendor_error",
          uncertain ? UNCERTAIN_TEXT : (res.vendorMessage ?? "The credit check failed"),
          origin, { vendorCode: code, traceId: res.traceId });
      }

      const d = res.data as Record<string, unknown>;
      const summary = summarise(d);
      const done = await transition(sb, ref, ["check_in_flight"], {
        status: "report_ready",
        group_id: d.groupId,
        bureau_enquiry_id: summary.enquiryId,
        report_json: d.experianCreditCheckData,
        report_summary: summary,
        affordability_json: d.affordabilityResponseModel ?? null,
        report_ready_at: new Date().toISOString(),
        pdf_status: "pending",
        mm_env: `${cfg.env}${mode === "mock" ? "-mock" : ""}`,
      }, "Credit report received");
      if (!done) return fail("invalid_state", "Record changed during the check", origin);

      // The report is saved; the PDF is a sub-state and must never push us past the wall clock.
      const remaining = WALL_CLOCK_BUDGET_MS - (Date.now() - startedAtMs);
      let pdf = "pending";
      if (remaining > 20_000) {
        try {
          pdf = await fetchPdf(ref, String(d.groupId), Math.min(PDF_TIMEOUT_MS, remaining - 10_000));
        } catch (e) {
          // The report is saved: a PDF problem must never turn report_ready into server_error.
          console.error(JSON.stringify({ event: "pdf_fetch_failed", message: String(e instanceof Error ? e.message : e).slice(0, 300) }));
          await sb.from("credit_checks").update({ pdf_status: "failed" }).eq("ref", ref);
          pdf = "failed";
        }
      }
      return ok({ status: "report_ready", summary, pdfStatus: pdf }, origin);
    }

    // ======================================================================================
    if (action === "fetch-pdf") {
      if (row.status !== "report_ready" || !row.group_id) {
        return fail("invalid_state", "No report to fetch a PDF for", origin);
      }
      if (row.pdf_status === "stored") return ok({ pdfStatus: "stored" }, origin);
      return ok({ pdfStatus: await fetchPdf(ref, row.group_id, PDF_TIMEOUT_MS) }, origin);
    }

    // ======================================================================================
    if (action === "refresh-consents") {
      if (!personId) return fail("bad_request", "No ID number on record", origin);
      // C9: never send the ID number for someone whose consent was never registered.
      if (!row.consent_registered_at) return fail("invalid_state", "consent_never_registered", origin);
      const rb = await readConsents();
      if (!rb.ok) return fail("vendor_error", "Could not read consents", origin, { vendorCode: rb.vendorCode, traceId: rb.traceId });
      return ok({ consents: rb.snapshot }, origin);
    }

    // ======================================================================================
    if (action === "record-withdrawal") {
      // C8: the person's right to withdraw stops OUR processing whatever MortgageMAX says.
      if (NO_WITHDRAWAL_FROM.includes(row.status)) {
        return fail("invalid_state", row.status === "check_in_flight"
          ? "A credit check is running for this record — record the withdrawal once it finishes"
          : `Nothing to withdraw from status ${row.status}`, origin);
      }
      const reason = body.reason ? `: ${String(body.reason).slice(0, 200)}` : "";
      const withdrawable = ALL_STATUSES.filter((st) => !NO_WITHDRAWAL_FROM.includes(st));
      // Claim locally FIRST: consent_withdrawn is in no allowedFrom() set, so a concurrent run-check
      // claim now fails, and an in-flight check can never be overwritten (it is excluded above).
      const claimed = await transition(sb, ref, withdrawable, {
        status: "consent_withdrawn", consent_withdrawn_at: new Date().toISOString(),
      }, `Consent withdrawal recorded by ${staffLabel}${reason}`);
      if (!claimed) return fail("invalid_state", "Record changed — reload and try again", origin);

      // "Never registered" must be judged on the CLAIMED row (not the one read at request start —
      // a registration can complete in between), and a registration POST that was ATTEMPTED but
      // timed out / 5xx'd releases consent_registered_at even though MortgageMAX may hold it. So if
      // any consent POST was ever sent for this ref, tell MortgageMAX.
      const { data: attempted, error: attemptErr } = await sb.from("mm_api_log").select("id")
        .eq("ref", ref).eq("api", "consent").eq("method", "POST").eq("path_redacted", "/Consents").limit(1);
      // Fail SAFE: if we cannot tell, assume it was sent — an extra granted=false is harmless, a
      // wrong "never registered" leaves MortgageMAX believing the person still consents. The audit
      // line written when a registration POST fails covers a lost log row.
      const auditSaysPosted = Array.isArray(claimed.audit) && claimed.audit.some((a: { event?: string }) =>
        typeof a?.event === "string" && a.event.startsWith("Consent registration with MortgageMax failed"));
      const everSent = !!claimed.consent_registered_at || !!attemptErr || auditSaysPosted ||
        (Array.isArray(attempted) && attempted.length > 0);
      if (!everSent) {
        // Never registered with MortgageMAX: nothing to tell the vendor, and no reason to send it the ID number.
        await transition(sb, ref, ["consent_withdrawn"], {},
          "Consent was never registered with MortgageMax — withdrawal recorded locally only");
        return ok({ status: "consent_withdrawn", localOnly: true }, origin);
      }
      if (!personId) {
        await transition(sb, ref, ["consent_withdrawn"], {},
          "MortgageMAX did not accept the withdrawal (no_id_number) — record it with MortgageMAX manually");
        return ok({ status: "consent_withdrawn", vendorRecorded: false, vendorCode: "no_id_number" }, origin);
      }

      // Withdraw exactly what this record registered (its 'registered' evidence rows), not today's
      // configuration; fall back to the configured types only when that evidence is missing.
      let items: WithdrawItem[] = [];
      let evidence: Array<{ id: string; version: string | null; hash: string | null }> = [];
      const { data: regRows } = await sb.from("consent_events")
        .select("consent_type_id, consent_version, declaration_hash, request_body")
        .eq("ref", ref).eq("event", "registered").order("created_at", { ascending: false });
      for (const r of regRows ?? []) {
        const id = String(r.consent_type_id ?? "");
        if (!id || items.some((it) => it.id.toLowerCase() === id.toLowerCase())) continue;
        const sent = Array.isArray(r.request_body?.consents)
          ? r.request_body.consents.find((c: { consentTypeId?: string }) => String(c?.consentTypeId).toLowerCase() === id.toLowerCase())
          : null;
        items.push({ id, context: sent?.context && typeof sent.context === "object" ? sent.context : {} });
        evidence.push({ id, version: r.consent_version ?? null, hash: r.declaration_hash ?? null });
      }
      if (items.length === 0) {
        try {
          const types = await loadConfiguredTypes(ctx);
          items = types.map((t) => ({ id: t.id, context: contextFor(t) }));
          evidence = await Promise.all(types.map(async (t) => ({ id: t.id, version: t.version, hash: await declarationHash(t) })));
        } catch {
          await transition(sb, ref, ["consent_withdrawn"], {},
            "MortgageMAX did not accept the withdrawal (consent_types_unavailable) — record it with MortgageMAX manually");
          return ok({ status: "consent_withdrawn", vendorRecorded: false, vendorCode: "consent_types_unavailable" }, origin);
        }
      }

      const wBody = buildWithdrawConsents({ personId, apiClientId: cfg.apiClientId, ref, items, createdBy: staffLabel });
      const w = await callVendor(cfg, "consent", "POST", "/Consents", { body: wBody, timeoutMs: 20_000, fetchImpl });
      await log("consent", "POST", "/Consents", w);
      if (!succeeded.consentPost(w)) {
        const vendorCode = w.vendorCode ?? `http_${w.http}`;
        await transition(sb, ref, ["consent_withdrawn"], {},
          `MortgageMAX did not accept the withdrawal (${vendorCode}) — record it with MortgageMAX manually`);
        return ok({ status: "consent_withdrawn", vendorRecorded: false, vendorCode }, origin);
      }
      const { error: evErr } = await sb.from("consent_events").insert(evidence.map((e) => ({
        ref, event: "withdrawn", consent_type_id: e.id, consent_version: e.version,
        declaration_hash: e.hash, granted: false,
        request_body: { ...wBody, personId: "[redacted]" }, response_body: w.text.slice(0, 500).replaceAll(personId, "[redacted]"),
        created_by: staffLabel,
      })));
      if (evErr) console.error(JSON.stringify({ event: "consent_events_insert_failed", message: evErr.message }));
      await transition(sb, ref, ["consent_withdrawn"], {}, "Withdrawal accepted by MortgageMax");
      await readConsents(); // C8: store what MortgageMAX now holds (best effort)
      return ok({ status: "consent_withdrawn", vendorRecorded: true }, origin);
    }

    // ======================================================================================
    if (action === "manual-upload-url") {
      // Step 1 of manual verification: a one-time signed upload URL for a path WE choose. The
      // bucket enforces type and size; manual-verify re-checks the bytes before anything counts.
      const can = manualVerifyCheck(row);
      if (!can.ok) return fail("invalid_state", `manual_not_allowed:${can.reason}`, origin);
      const path = idDocPath(ref, String(body.contentType ?? ""));
      if (!path) return fail("bad_request", "The ID copy must be a PDF, JPG or PNG", origin);
      const { data: up, error: upErr } = await sb.storage.from(ID_DOC_BUCKET).createSignedUploadUrl(path);
      if (upErr || !up) return fail("server_error", "Could not prepare the upload", origin);
      return ok({ path: up.path, token: up.token, maxBytes: ID_DOC_MAX_BYTES }, origin);
    }

    // ======================================================================================
    if (action === "manual-verify") {
      // Step 2: the consultant confirmed the attestation. The stored text is OURS (never the
      // browser's), the version must match what the page showed, and the file must really be an
      // ID copy of an accepted type that was uploaded for this ref.
      if (body.attested !== true) return fail("bad_request", "Confirm the statement first", origin);
      if (body.attestationVersion !== ATTESTATION.version) {
        return fail("invalid_state", "manual_attestation_changed", origin);
      }
      if (!validIdDocPath(ref, body.path)) return fail("bad_request", "Upload the ID copy first", origin);
      const can = manualVerifyCheck(row);
      if (!can.ok) return fail("invalid_state", `manual_not_allowed:${can.reason}`, origin);

      const { data: blob, error: dlErr } = await sb.storage.from(ID_DOC_BUCKET).download(body.path);
      if (dlErr || !blob) return fail("bad_request", "The ID copy was not uploaded — try the upload again", origin);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const discard = async () => {
        const rm = await sb.storage.from(ID_DOC_BUCKET).remove([body.path as string]);
        // Not fatal (delete-record sweeps the ref's folder) but never silent: it is personal data.
        if (rm.error) console.error(JSON.stringify({ event: "id_doc_discard_failed", ref, message: rm.error.message }));
      };
      if (bytes.length === 0 || bytes.length > ID_DOC_MAX_BYTES) {
        await discard();
        return fail("bad_request", "The ID copy is empty or larger than 10 MB", origin);
      }
      const type = sniffDocType(bytes);
      if (!type || ID_DOC_TYPES[type] !== body.path.split(".").pop()) {
        await discard();
        return fail("bad_request", "The file is not a readable PDF, JPG or PNG", origin);
      }

      const { data: evidenceId, error: rpcErr } = await sb.rpc("record_manual_verification", {
        p_ref: ref, p_from: row.status, p_user: user.id, p_label: staffLabel,
        p_version: ATTESTATION.version, p_text: ATTESTATION.text,
        p_path: body.path, p_type: type, p_bytes: bytes.length, p_sha256: await sha256HexBytes(bytes),
      });
      if (rpcErr) {
        await discard();
        throw new Error(`server_error: ${rpcErr.message}`);
      }
      if (evidenceId === null || evidenceId === undefined) {
        // The record moved on while the consultant was working — nothing was recorded.
        await discard();
        return fail("invalid_state", "Record changed — reload and try again", origin);
      }
      return ok({ status: "manual_verified", evidenceId }, origin);
    }

    // ======================================================================================
    if (action === "reissue-idv-link") {
      // The client's 30-minute session lapsed before they could answer the identity questions. A
      // fresh token (only its hash is stored) replaces the old one, so any earlier link stops
      // working. It is returned once, for the consultant to send; it is never logged or stored.
      const can = idvLinkCheck(row, idvMode);
      if (!can.ok) return fail("invalid_state", `idv_link_not_allowed:${can.reason}`, origin);
      const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
      const expiresAt = new Date(Date.now() + IDV_LINK_TTL_MS).toISOString();
      const patch = { idv_token_hash: await sha256Hex(token), idv_token_expires: expiresAt, updated_at: new Date().toISOString() };
      const upd = await sb.from("credit_check_secrets").update(patch).eq("ref", ref).select("ref");
      if (upd.error) throw new Error(`server_error: ${upd.error.message}`);
      if (!upd.data || upd.data.length === 0) {
        const ins = await sb.from("credit_check_secrets").insert({ ref, ...patch });
        if (ins.error) throw new Error(`server_error: ${ins.error.message}`);
      }
      // Audit line, guarded by the status we checked: if the record moved on meanwhile, withdraw
      // the token again rather than hand out a link for a record that can no longer use it.
      const logged = await transition(sb, ref, [row.status], {},
        `Identity-check link re-issued by ${staffLabel} (valid 24 hours; any earlier link stops working)`);
      if (!logged) {
        await sb.from("credit_check_secrets").update({ idv_token_hash: null, idv_token_expires: null }).eq("ref", ref);
        return fail("invalid_state", "Record changed — reload and try again", origin);
      }
      return ok({ token, expiresAt }, origin);
    }

    // ======================================================================================
    if (action === "delete-record") {
      // Destroy on request (PCR declaration undertaking): the stored PDF goes with the row, and the
      // vendor response bodies logged for this ref are blanked. consent_events (redacted evidence of
      // consent) and the metadata of mm_api_log are retained by design, plus a 'deleted' marker.
      if (row.status === "check_in_flight") {
        return fail("invalid_state", "A credit check is running for this record — try again shortly", origin);
      }
      const readyAt = row.report_ready_at ? new Date(row.report_ready_at).getTime() : 0;
      if (row.pdf_status === "fetching" && !(readyAt && Date.now() - readyAt > PDF_FETCH_STALE_MS)) {
        return fail("invalid_state", "The report PDF is still being fetched — try again shortly", origin);
      }
      // Every object under the ref's folder, page by page — destroy-on-request must not stop at 100.
      const listAll = async (bucket: string): Promise<string[] | null> => {
        const out: string[] = [];
        for (let offset = 0; ; offset += 100) {
          const { data, error } = await sb.storage.from(bucket).list(ref, { limit: 100, offset });
          if (error) return null;
          for (const o of data ?? []) if (o?.name) out.push(`${ref}/${o.name}`);
          if (!data || data.length < 100) return out;
        }
      };
      const paths = new Set<string>();
      if (row.report_pdf_path) paths.add(String(row.report_pdf_path));
      const reportObjects = await listAll("credit-reports");
      if (reportObjects === null) return fail("server_error", "Could not list the stored report PDFs", origin);
      for (const pth of reportObjects) paths.add(pth);
      if (paths.size) {
        const rm = await sb.storage.from("credit-reports").remove([...paths]);
        if (rm.error) return fail("server_error", "Could not delete the stored report PDF", origin);
      }
      // The client's ID copy goes too; the evidence row keeps who attested and the file's hash.
      const idDocs = await listAll(ID_DOC_BUCKET);
      if (idDocs === null) return fail("server_error", "Could not list the stored ID copies", origin);
      if (idDocs.length) {
        const rm = await sb.storage.from(ID_DOC_BUCKET).remove(idDocs);
        if (rm.error) return fail("server_error", "Could not delete the stored ID copy", origin);
      }
      const blank = await sb.from("mm_api_log").update({ body_head: null }).eq("ref", ref);
      if (blank.error) return fail("server_error", "Could not clear the logged vendor responses", origin);
      const del = await sb.from("credit_checks").delete().eq("ref", ref);
      if (del.error) {
        return fail("server_error", idDocs.length || paths.size
          ? "The stored files were deleted but the record could not be — use Delete again to finish"
          : "Could not delete the record", origin);
      }
      // Only once the row is gone: a failed delete must not leave live evidence marked as deleted.
      // The files are already removed, so a failed stamp is logged rather than reported as a failure.
      const stamped = await sb.from("manual_verifications").update({ document_deleted_at: new Date().toISOString() })
        .eq("ref", ref).is("document_deleted_at", null);
      if (stamped.error) console.error(JSON.stringify({ event: "id_doc_stamp_failed", ref, code: stamped.error.code, message: stamped.error.message }));
      // Only after the row is really gone: a failed delete must not leave a "Deleted" marker on a live record.
      const marker = await sb.from("consent_events").insert({ ref, event: "deleted", created_by: staffLabel });
      if (marker.error) {
        // Until the hardening migration widens the event CHECK, the marker cannot be stored.
        console.error(JSON.stringify({ event: "deleted_marker_failed", ref, message: marker.error.message }));
      }
      console.log(JSON.stringify({ event: "record_deleted", ref, by: user.id, hadReport: !!row.report_json, removedObjects: paths.size + idDocs.length }));
      return ok({ deleted: true }, origin);
    }

    return fail("bad_request", `Unknown action ${action}`, origin);
  } catch (e) {
    const msg = String(e instanceof Error ? e.message : e);
    console.error(JSON.stringify({ event: "mm_staff_error", action, message: personId ? msg.replaceAll(personId, "[redacted]") : msg }));
    if (msg.startsWith("config_error")) return fail("config_error", "Service is not configured", origin);
    return fail("server_error", "Something went wrong", origin);
  }

  // ---- PDF: a sub-state of report_ready, never a blocker (D8) ----------------------------
  async function fetchPdf(r: string, groupId: string, timeoutMs: number): Promise<string> {
    const attempt = (row.pdf_attempts ?? 0) + 1;
    await sb.from("credit_checks").update({ pdf_status: "fetching", pdf_attempts: attempt }).eq("ref", r);
    const path = `/CreditCheck/getDocument/${encodeURIComponent(groupId)}/true/true`;
    const res = await callVendor(cfg, "credit", "GET", path, { timeoutMs, fetchImpl });
    await log("credit", "GET", "/CreditCheck/getDocument/{groupId}/true/true", res);

    let bytes: Uint8Array | null = null;
    try {
      if (res.http === 200 && res.kind === "pdf_base64") bytes = base64ToBytes(String(res.data));
      else if (res.http === 200 && res.kind === "url") {
        const u = new URL(String(res.data));
        if (u.protocol === "https:" && u.hostname.endsWith(".blob.core.windows.net")) {
          const f = await fetch(u, { signal: AbortSignal.timeout(timeoutMs) });
          if (f.ok) bytes = new Uint8Array(await f.arrayBuffer());
        }
      }
    } catch { bytes = null; }

    if (!bytes || bytes.length < 8) {
      await sb.from("credit_checks").update({ pdf_status: "failed" }).eq("ref", r);
      return "failed";
    }
    const locked = pdfIsEncrypted(bytes);
    const objectPath = `${r}/${groupId}.pdf`;
    const up = await sb.storage.from("credit-reports").upload(objectPath, bytes, { contentType: "application/pdf", upsert: true });
    if (up.error) {
      console.error(JSON.stringify({ event: "pdf_upload_failed", message: up.error.message }));
      await sb.from("credit_checks").update({ pdf_status: "failed" }).eq("ref", r);
      return "failed";
    }
    const status = locked ? "locked" : "stored";
    const { data: kept } = await sb.from("credit_checks").update({ pdf_status: status, report_pdf_path: objectPath })
      .eq("ref", r).select("ref");
    if (!kept || kept.length === 0) {
      // The record was deleted while the PDF was downloading — the report must not outlive it (C12).
      const rm = await sb.storage.from("credit-reports").remove([objectPath]);
      if (rm.error) console.error(JSON.stringify({ event: "orphan_pdf_remove_failed", ref: r, message: rm.error.message }));
      return "failed";
    }
    return status;
  }

  // ---- GET /Consents read-back: store the snapshot + a 'readback' evidence row (C8, C9) -------
  async function readConsents(): Promise<
    { ok: true; snapshot: unknown[] } | { ok: false; vendorCode: string | null; traceId: string | null }
  > {
    const rb = await callVendor(cfg, "consent", "GET", "/Consents", { query: { PersonId: personId }, timeoutMs: 20_000, fetchImpl });
    await log("consent", "GET", "/Consents", rb);
    if (rb.http !== 200 || !Array.isArray(rb.data)) return { ok: false, vendorCode: rb.vendorCode, traceId: rb.traceId };
    const snapshot = rb.data as unknown[];
    await sb.from("credit_checks").update({ mm_consents_snapshot: snapshot, mm_consents_synced_at: new Date().toISOString() }).eq("ref", ref);
    await sb.from("consent_events").insert({
      ref, event: "readback", request_body: { snapshot },
      response_body: `${snapshot.length} consent(s)`, created_by: staffLabel,
    });
    return { ok: true, snapshot };
  }
});
