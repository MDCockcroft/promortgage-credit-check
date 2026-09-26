// mm-staff — the STAFF-ONLY Edge Function (BUILD-PLAN D2, D8, D9).
// The only code path that can run a (billable) credit check. Caller must be a signed-in staff user.
//
// Auth: deployed with --no-verify-jwt because this project signs session tokens with the new key
// system; the function verifies the bearer itself via auth.getUser() — that call is authoritative.
// Any authenticated user is staff (matches RLS staff_all; public sign-ups are disabled).
//
// POST { action: 'config' }
// POST { ref, action: 'run-check' | 'fetch-pdf' | 'refresh-consents' | 'record-withdrawal' | 'register-consent'
//              | 'delete-record' | 'recover' | 'clear-config-error', force?, reason? }
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
import { logCall, serviceClient, transition } from "../_shared/db.ts";
import { mockFetch } from "../_shared/mock.ts";
import { base64ToBytes, num, pdfIsEncrypted, summarise } from "../_shared/report.ts";
import { recoverStale } from "../_shared/recover.ts";
import { personIdFor } from "../_shared/idnumber.ts";

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

import { ALL_STATUSES, allowedFrom, configErrorTarget, type IdvMode } from "../_shared/states.ts";

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

  let body: { ref?: string; action?: string; force?: boolean; reason?: string };
  try {
    body = await req.json();
  } catch {
    return fail("bad_request", "Body must be JSON", origin);
  }
  const { ref, action } = body;
  if (action === "config") {
    // What admin.html needs to render the right controls (e.g. the IDV override checkbox).
    return ok({
      mode: Deno.env.get("MM_MODE") === "live" ? "live" : "mock",
      idvMode: idvModeFromEnv(),
      env: cfg.env,
      allowPassport: Deno.env.get("ALLOW_PASSPORT") === "true",
    }, origin);
  }
  if (!ref || !action) return fail("bad_request", "ref and action are required", origin);

  const { data: row } = await sb.from("credit_checks").select("*").eq("ref", ref).maybeSingle();
  if (!row) return fail("bad_request", "No such record", origin);

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
      const force = body.force === true && idvMode === "optional";
      const from = allowedFrom(idvMode, force);
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
      }, force
        ? `Credit check requested by ${staffLabel} (identity-check override: ${String(body.reason ?? "no reason given").slice(0, 200)})`
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
      const paths = new Set<string>();
      if (row.report_pdf_path) paths.add(String(row.report_pdf_path));
      const { data: listed } = await sb.storage.from("credit-reports").list(ref, { limit: 100 });
      for (const o of listed ?? []) if (o?.name) paths.add(`${ref}/${o.name}`);
      if (paths.size) {
        const rm = await sb.storage.from("credit-reports").remove([...paths]);
        if (rm.error) return fail("server_error", "Could not delete the stored report PDF", origin);
      }
      const blank = await sb.from("mm_api_log").update({ body_head: null }).eq("ref", ref);
      if (blank.error) return fail("server_error", "Could not clear the logged vendor responses", origin);
      const del = await sb.from("credit_checks").delete().eq("ref", ref);
      if (del.error) return fail("server_error", "Could not delete the record", origin);
      // Only after the row is really gone: a failed delete must not leave a "Deleted" marker on a live record.
      const marker = await sb.from("consent_events").insert({ ref, event: "deleted", created_by: staffLabel });
      if (marker.error) {
        // Until the hardening migration widens the event CHECK, the marker cannot be stored.
        console.error(JSON.stringify({ event: "deleted_marker_failed", ref, message: marker.error.message }));
      }
      console.log(JSON.stringify({ event: "record_deleted", ref, by: user.id, hadReport: !!row.report_json, removedObjects: paths.size }));
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
