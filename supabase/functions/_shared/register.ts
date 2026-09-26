// Consent registration with MortgageMax — ONE implementation, used by mm-client (client, straight
// after OTP) and mm-staff (consultant retry when the client's session expired or the vendor was down).
// BUILD-PLAN D4, D5, D6, D11, D13.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { callVendor, type MmConfig, succeeded, type VendorResult } from "./mmax.ts";
import {
  buildCreateConsents,
  buildWithdrawConsents,
  consentGrantState,
  type ConsentType,
  configuredTypeIds,
  contextFor,
  declarationHash,
  pickTypes,
  renderDeclaration,
  staleAgainst,
} from "./consents.ts";
import { transition } from "./db.ts";
import { loaderCache } from "./cache.ts";
import { idProblem, personIdFor } from "./idnumber.ts";
import fixtureTypes from "./fixtures/consent-types-active.json" with { type: "json" };

export type IdvMode = "off" | "optional" | "required";
export type Mode = "live" | "mock";

export interface Ctx {
  sb: SupabaseClient;
  cfg: MmConfig;
  mode: Mode;
  fetchImpl?: typeof fetch;
  log: (api: "credit" | "consent", method: string, path: string, r: VendorResult) => Promise<void>;
}

export type Outcome =
  | { ok: true; status: string; idvMode: IdvMode; reason?: string }
  | { ok: false; code: "invalid_state" | "vendor_error" | "config_error" | "bad_request"; message: string; vendorCode?: string | null; traceId?: string | null };

export function idvModeFromEnv(): IdvMode {
  const v = Deno.env.get("MM_IDV_MODE");
  return v === "optional" || v === "required" ? v : "off";
}

// ---------------------------------------------------------------------------------------------
// Configured consent types, live or fixture. Cached per isolate for an hour (public read path);
// a vendor failure is cached for 60 s so anonymous traffic cannot hammer MortgageMAX (C14).
// ---------------------------------------------------------------------------------------------
const typesCache = loaderCache<ConsentType[]>(60 * 60 * 1000, 60 * 1000);

export async function loadConfiguredTypes(ctx: Ctx, opts: { fresh?: boolean } = {}): Promise<ConsentType[]> {
  const ids = configuredTypeIds(Deno.env.get("MM_CONSENT_TYPES"));
  const all = await typesCache.get(ctx.mode, async () => {
    if (ctx.mode === "mock") return fixtureTypes as ConsentType[];
    const r = await callVendor(ctx.cfg, "consent", "GET", "/ConsentTypes", { timeoutMs: 20_000, fetchImpl: ctx.fetchImpl });
    await ctx.log("consent", "GET", "/ConsentTypes", r);
    if (r.http === 401 || r.http === 403) throw new Error(`config_error: vendor rejected credentials (${r.http})`);
    if (r.http !== 200 || !Array.isArray(r.data)) throw new Error(`vendor_error: could not load consent types (${r.vendorCode ?? r.http})`);
    return r.data as ConsentType[];
  }, opts);
  return pickTypes(all, ids);
}

/** What the public form renders: rendered wording + the version/hash the client will echo back. */
export async function publicConsentTypes(ctx: Ctx) {
  const types = await loadConfiguredTypes(ctx);
  return Promise.all(types.map(async (t) => {
    const declaration = renderDeclaration(t.declaration);
    return {
      id: t.id,
      name: t.name,
      version: t.version,
      declaration,
      isHtml: /<\s*(p|br|div|ul|ol|li|a|strong|b|em|i|sup|span)\b/i.test(declaration),
      hash: await declarationHash(t),
    };
  }));
}

// ---------------------------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------------------------
/** A registration claim older than this belongs to a request that died mid-call (60 s of vendor time max). */
const STALE_CLAIM_MS = 3 * 60 * 1000;

export const MSG_RECONSENT = "Consent wording changed or was not shown — client must re-consent";
export const MSG_PRIOR_WITHDRAWAL =
  "Previous withdrawal on record — consultant must confirm with the person before re-registering";

export async function registerConsent(
  ctx: Ctx,
  row: Record<string, unknown>,
  createdBy: string,
): Promise<Outcome> {
  const { sb, cfg } = ctx;
  const ref = String(row.ref);
  const idvMode = idvModeFromEnv();

  if (row.status !== "consent_confirmed") {
    return { ok: false, code: "invalid_state", message: `Consent cannot be registered from status ${row.status}` };
  }

  // C6a — CLAIM before any vendor call, without a new status: consent_registered_at doubles as the
  // claim marker. A concurrent client + staff retry (or a withdrawal racing us) finds it taken.
  const claimedAt = new Date().toISOString();
  const staleBefore = new Date(Date.now() - STALE_CLAIM_MS).toISOString();
  const { data: claim, error: claimErr } = await sb.from("credit_checks")
    .update({ consent_registered_at: claimedAt })
    .eq("ref", ref).eq("status", "consent_confirmed")
    .or(`consent_registered_at.is.null,consent_registered_at.lt."${staleBefore}"`)
    .select("ref");
  if (claimErr) throw new Error(`server_error: ${claimErr.message}`);
  if (!claim || claim.length === 0) return { ok: false, code: "invalid_state", message: "registration_in_progress" };

  let posted = false; // after the POST the vendor may hold the consent: the claim is then never released
  try {
    return await registerClaimed();
  } catch (e) {
    if (!posted) {
      try {
        await transition(sb, ref, ["consent_confirmed"], { consent_registered_at: null });
      } catch { /* the stale-claim window frees it */ }
    }
    throw e;
  }

  async function registerClaimed(): Promise<Outcome> {
    /** Every exit that leaves the row in consent_confirmed releases the claim. */
    const release = async (event?: string) => {
      await transition(sb, ref, ["consent_confirmed"], { consent_registered_at: null }, event);
    };
    /** Every exit to manual_required clears the marker too: nothing was registered. */
    const toManual = async (event: string, reason = "manual"): Promise<Outcome> => {
      const moved = await transition(sb, ref, ["consent_confirmed"], { status: "manual_required", consent_registered_at: null }, event);
      if (!moved) return { ok: false, code: "invalid_state", message: "Record changed during registration" };
      return { ok: true, status: "manual_required", idvMode, reason };
    };

    // D11: /CreditCheck/full has no idType/DOB — passport applicants take the manual path until proven.
    if (row.id_type === "passport" && Deno.env.get("ALLOW_PASSPORT") !== "true") {
      return toManual("Passport applicant — routed to consultant (automated check supports SA ID numbers only)", "passport");
    }
    // C6b — the number we send must be the one the id_type says, and a real SA ID shape.
    const problem = idProblem(row);
    if (problem) return toManual(problem, "invalid_id");
    const personId = personIdFor(row);

    let types: ConsentType[];
    try {
      types = await loadConfiguredTypes(ctx, { fresh: true }); // never register against a cached version
    } catch (e) {
      const msg = String(e instanceof Error ? e.message : e);
      await release();
      return msg.startsWith("config_error")
        ? { ok: false, code: "config_error", message: msg }
        : { ok: false, code: "vendor_error", message: "Could not load consent wording" };
    }

    // D13 / C6c: the client must have been shown exactly this wording — otherwise only a new
    // submission can fix it, so hand it to the consultant instead of leaving a retry that cannot work.
    const presented = Array.isArray(row.consents_presented) ? row.consents_presented : null;
    if (!presented || presented.length === 0) return toManual(`${MSG_RECONSENT} (consent_not_presented)`, "consent_stale");
    const covered = types.every((t) => presented.some((p: { id?: string }) => String(p.id).toLowerCase() === t.id.toLowerCase()));
    const stale = await staleAgainst(presented, types);
    if (!covered || stale.length) return toManual(`${MSG_RECONSENT} (consent_stale)`, "consent_stale");

    // C6d — PRE-READ: a POST replaces the vendor record (P11). Never overwrite a recorded
    // withdrawal/decline, ours or anyone's, without a consultant speaking to the person first.
    const pre = await callVendor(cfg, "consent", "GET", "/Consents", {
      query: { PersonId: personId }, timeoutMs: 20_000, fetchImpl: ctx.fetchImpl,
    });
    await ctx.log("consent", "GET", "/Consents", pre);
    if (pre.http === 401 || pre.http === 403) {
      await transition(sb, ref, ["consent_confirmed"], { status: "config_error", consent_registered_at: null },
        `MortgageMax rejected our credentials (${pre.http})`);
      return { ok: false, code: "config_error", message: "vendor rejected credentials" };
    }
    if (pre.http !== 200 || !Array.isArray(pre.data)) {
      await release();
      return { ok: false, code: "vendor_error", message: "Could not read existing consents", vendorCode: pre.vendorCode, traceId: pre.traceId };
    }
    const priorRefusal = consentGrantState(pre.data, types.map((t) => t.id)).anyRefused;
    let priorWithdrawnHere = false;
    const mmPersonId = row.mm_person_id ? String(row.mm_person_id) : "";
    if (mmPersonId) {
      const { data: others, error: othersErr } = await sb.from("credit_checks").select("ref")
        .eq("mm_person_id", mmPersonId).eq("status", "consent_withdrawn").neq("ref", ref).limit(1);
      if (othersErr) {
        await release();
        throw new Error(`server_error: ${othersErr.message}`);
      }
      priorWithdrawnHere = !!others && others.length > 0;
    }
    if (priorRefusal || priorWithdrawnHere) return toManual(MSG_PRIOR_WITHDRAWAL, "prior_withdrawal");

    const body = buildCreateConsents({ personId, apiClientId: cfg.apiClientId, ref, types, granted: true, createdBy });
    // The pre-read above can take up to ~40 s against a slow vendor: re-check we still own a
    // consent_confirmed row immediately before the write that would replace a withdrawal.
    const { data: still } = await sb.from("credit_checks").select("status").eq("ref", ref).maybeSingle();
    if (still?.status !== "consent_confirmed") {
      return { ok: false, code: "invalid_state", message: "Record changed during registration" };
    }
    posted = true;
    const post = await callVendor(cfg, "consent", "POST", "/Consents", { body, timeoutMs: 20_000, fetchImpl: ctx.fetchImpl });
    await ctx.log("consent", "POST", "/Consents", post);
    if (post.http === 401 || post.http === 403) {
      // consent_registered_at null → clear-config-error returns the record to consent_confirmed (C2).
      await transition(sb, ref, ["consent_confirmed"], { status: "config_error", consent_registered_at: null },
        `MortgageMax rejected our credentials (${post.http})`);
      return { ok: false, code: "config_error", message: "vendor rejected credentials" };
    }
    if (!succeeded.consentPost(post)) {
      // An uncertain failure (timeout / network / 5xx) may still have landed at MortgageMAX. If a
      // withdrawal was recorded meanwhile, our possible granted=true must be undone.
      const { data: nowRow } = await sb.from("credit_checks").select("status").eq("ref", ref).maybeSingle();
      if (nowRow?.status === "consent_withdrawn") {
        await rewithdraw(ctx, ref, personId, types, createdBy);
        return { ok: false, code: "invalid_state", message: "Record changed during registration" };
      }
      await release(`Consent registration with MortgageMax failed (${post.vendorCode ?? post.http}) — can be retried`);
      return { ok: false, code: "vendor_error", message: "Consent registration failed", vendorCode: post.vendorCode, traceId: post.traceId };
    }

    // D6: the vendor's consent id is not durable — snapshot the read-back, keep our own evidence.
    const readback = await callVendor(cfg, "consent", "GET", "/Consents", {
      query: { PersonId: personId }, timeoutMs: 20_000, fetchImpl: ctx.fetchImpl,
    });
    await ctx.log("consent", "GET", "/Consents", readback);
    const snapshot = Array.isArray(readback.data) ? readback.data as Array<Record<string, unknown>> : null;

    const redactedBody = { ...body, personId: "[redacted]" };
    const { error: evErr } = await sb.from("consent_events").insert(await Promise.all(types.map(async (t) => {
      const match = snapshot?.find((c) => String(c.consentTypeId).toLowerCase() === t.id.toLowerCase());
      const hash = await declarationHash(t);
      return {
        ref, event: "registered", consent_type_id: t.id, consent_version: t.version,
        declaration_hash: hash, granted: true,
        otp_confirmed_at: row.consent_confirmed_at ?? null,
        // C6e: the exact wording the hash stands for, so the evidence survives the vendor's next version.
        request_body: { ...redactedBody, _evidence: { declaration: renderDeclaration(t.declaration), version: t.version, hash } },
        response_body: post.text.slice(0, 500).split(personId).join("[redacted]"),
        vendor_created_date: typeof match?.createdDate === "string" ? match.createdDate : null,
        created_by: createdBy,
      };
    })));
    if (evErr) console.error(JSON.stringify({ event: "consent_events_insert_failed", message: evErr.message }));

    const next = idvMode === "off" ? "idv_waived" : "consent_registered";
    const updated = await transition(sb, ref, ["consent_confirmed"], {
      status: next,
      consent_registered_at: new Date().toISOString(),
      mm_consents_snapshot: snapshot,
      mm_consents_synced_at: new Date().toISOString(),
      mm_env: `${cfg.env}${ctx.mode === "mock" ? "-mock" : ""}`,
    }, idvMode === "off"
      ? "Consent registered with MortgageMax; identity questions waived by configuration"
      : "Consent registered with MortgageMax");
    if (!updated) {
      // Only a withdrawal (or delete) can move a claimed consent_confirmed row. If the withdrawal's
      // granted=false reached MortgageMAX before our granted=true, ours replaced it (P11) — put it back.
      const { data: now } = await sb.from("credit_checks").select("status").eq("ref", ref).maybeSingle();
      if (now?.status === "consent_withdrawn") await rewithdraw(ctx, ref, personId, types, createdBy);
      return { ok: false, code: "invalid_state", message: "Record changed during registration" };
    }
    return { ok: true, status: next, idvMode };
  }
}

/** Compensating granted=false after a registration lost a race with a withdrawal. Best effort. */
async function rewithdraw(ctx: Ctx, ref: string, personId: string, types: ConsentType[], createdBy: string) {
  try {
    const body = buildWithdrawConsents({
      personId, apiClientId: ctx.cfg.apiClientId, ref, createdBy,
      items: types.map((t) => ({ id: t.id, context: contextFor(t) })),
    });
    const w = await callVendor(ctx.cfg, "consent", "POST", "/Consents", { body, timeoutMs: 20_000, fetchImpl: ctx.fetchImpl });
    await ctx.log("consent", "POST", "/Consents", w);
    if (succeeded.consentPost(w)) {
      const { error } = await ctx.sb.from("consent_events").insert(await Promise.all(types.map(async (t) => ({
        ref, event: "withdrawn", consent_type_id: t.id, consent_version: t.version,
        declaration_hash: await declarationHash(t), granted: false,
        request_body: { ...body, personId: "[redacted]" }, response_body: w.text.slice(0, 500).split(personId).join("[redacted]"),
        created_by: createdBy,
      }))));
      if (error) console.error(JSON.stringify({ event: "consent_events_insert_failed", message: error.message }));
    }
    await transition(ctx.sb, ref, ["consent_withdrawn"], {}, succeeded.consentPost(w)
      ? "Registration raced the withdrawal — withdrawal re-sent to MortgageMax"
      : `Registration raced the withdrawal and MortgageMax did not accept the re-sent withdrawal (${w.vendorCode ?? w.http}) — record it with MortgageMAX manually`);
  } catch (e) {
    console.error(JSON.stringify({ event: "rewithdraw_failed", message: String(e instanceof Error ? e.message : e).split(personId).join("[redacted]") }));
  }
}
