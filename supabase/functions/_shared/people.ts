// MortgageMAX People domain (BT People Management API v2) — MortgageMAX, 2026-10-20: consent must be
// keyed to a PERSON RECORD on their side, not to the raw ID number. Before registering consent we look
// the ID number up; if it is unknown we create the person with the minimum they require; the id that
// comes back is what goes on the consent, the consent read-back, a withdrawal and the credit check's
// idConcent. The ID number itself still goes where identity is proven (questions, idNumber).
//
// Matching is by ID number ONLY. Their API also finds a person by mobile or email, but a family
// sharing a phone would put one person's consent on another's profile; the ID number is the identity.
// A found person whose identity document does not carry our ID number is refused (person_mismatch).
//
// Switched on by MMAX_PEOPLE_BASE_URL. The reference ids are checked HERE, on the People path only, so
// a half-set configuration breaks consent registration (config_error, visible on the record) and
// nothing else. Without the base URL, nothing changes: personId stays the ID number.
import { callVendor, type MmConfig, type VendorResult } from "./mmax.ts";

export interface PeopleRefs {
  sourceSystemTypeId: number;
  identityDocumentTypeId: number;
  countryOfOriginId: string;
  phoneNumberTypeId?: number;
  emailAddressTypeId?: number;
}

export function peopleEnabled(cfg: MmConfig): boolean {
  return !!cfg.peopleBaseUrl;
}

/** The reference ids the create call needs; a base URL without them is a configuration error, never a fallback. */
export function peopleRefs(cfg: MmConfig): PeopleRefs {
  if (!cfg.peopleBaseUrl) throw new Error("config_error: MMAX_PEOPLE_BASE_URL is not set");
  const p = cfg.people ?? {};
  const missing: string[] = [];
  if (!p.sourceSystemTypeId) missing.push("MMAX_PEOPLE_SOURCE_SYSTEM_ID");
  if (!p.identityDocumentTypeId) missing.push("MMAX_PEOPLE_ID_DOC_TYPE_ID");
  if (!p.countryOfOriginId) missing.push("MMAX_PEOPLE_COUNTRY_ID");
  if (missing.length) throw new Error(`config_error: People domain incomplete — ${missing.join(", ")} (positive integers / a country id)`);
  return {
    sourceSystemTypeId: p.sourceSystemTypeId!, identityDocumentTypeId: p.identityDocumentTypeId!, countryOfOriginId: p.countryOfOriginId!,
    phoneNumberTypeId: p.phoneNumberTypeId, emailAddressTypeId: p.emailAddressTypeId,
  };
}

/** The create body: name + ID document, the cellphone and email as primary contacts. Nothing else. */
export function buildCreatePerson(row: Record<string, unknown>, idNumber: string, refs: PeopleRefs, opts: { contacts: boolean } = { contacts: true }): Record<string, unknown> {
  const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const body: Record<string, unknown> = {
    name: { givenName: s(row.first_names), familyName: s(row.surname) },
    sourceSystemTypeId: refs.sourceSystemTypeId,
    identityDocument: {
      identityDocumentTypeId: refs.identityDocumentTypeId,
      identityNumber: idNumber,
      countryOfOriginId: refs.countryOfOriginId,
      isVerified: false,
    },
  };
  if (opts.contacts && s(row.cell)) {
    body.phoneNumbers = [{ value: s(row.cell), isPrimary: true, ...(refs.phoneNumberTypeId ? { phoneNumberTypeId: refs.phoneNumberTypeId } : {}) }];
  }
  if (opts.contacts && s(row.email)) {
    body.emailAddresses = [{ value: s(row.email), isPrimary: true, ...(refs.emailAddressTypeId ? { emailAddressTypeId: refs.emailAddressTypeId } : {}) }];
  }
  return body;
}

const NOT_IDS = new Set(["null", "undefined", "none", "true", "false", "ok", "created", "success", "error", "notfound", "conflict", "string"]);
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An id we are prepared to key a consent on: a GUID, or a token with letters and digits, never a word. */
export function plausiblePersonId(v: unknown): string | null {
  const t = typeof v === "number" && Number.isInteger(v) && v > 0 ? String(v) : typeof v === "string" ? v.trim().replace(/^"|"$/g, "") : "";
  if (!t || t.length < 4 || t.length > 128 || /\s/.test(t)) return null;
  if (NOT_IDS.has(t.toLowerCase())) return null;
  if (/^0+(-0+)*$/.test(t.replace(/[^0-9-]/g, "")) && !/[1-9a-z]/i.test(t)) return null; // all zeros
  if (GUID.test(t)) return /[1-9a-f]/i.test(t) ? t : null;
  if (/^[0-9]+$/.test(t)) return t;
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(t) && /[0-9]/.test(t) && t.length >= 8 ? t : null;
}

/**
 * The person id in a People API answer. A FIND answers the person object (its `id`); a bare string is
 * never a found person. A CREATE answers 201 with the new id as a bare string (spec example "string",
 * like POST /Consents) — or, defensively, an object with `id`.
 */
export function personIdFrom(r: VendorResult, from: "find" | "create"): string | null {
  const d = r.data;
  if (d && typeof d === "object" && !Array.isArray(d)) {
    const o = d as Record<string, unknown>;
    return plausiblePersonId(o.id ?? o.personId ?? o.value);
  }
  if (from === "create" && typeof d === "string") return plausiblePersonId(d);
  return null;
}

/** The ID number on a found person, when the answer carries one. */
function foundIdNumber(r: VendorResult): string | null {
  const d = r.data as Record<string, unknown> | null;
  const doc = d && typeof d === "object" ? (d as Record<string, unknown>).identityDocument : null;
  const n = doc && typeof doc === "object" ? (doc as Record<string, unknown>).identityNumber : null;
  return typeof n === "string" && n.trim() ? n.trim() : null;
}

export type ResolveOutcome =
  | { ok: true; personId: string; created: boolean }
  | { ok: false; code: "config_error" | "vendor_error"; http: number; vendorCode: string | null; traceId: string | null; step: "find" | "create" }
  /** The vendor's data needs a person to sort out: never retried blindly. */
  | { ok: false; code: "manual"; reason: "duplicate_person" | "person_rejected" | "person_mismatch"; http: number; vendorCode: string | null; vendorMessage: string | null };

export interface PeopleCtx {
  cfg: MmConfig;
  fetchImpl?: typeof fetch;
  log: (method: string, path: string, r: VendorResult) => Promise<void>;
}

/**
 * Find the person by ID number, else create them. The ID number never goes into a logged path.
 * 409 on the lookup = duplicate persons at the vendor; 409 on the create = someone made the person in
 * between (one re-read); 400 on the create = retried once without the contacts, then a person decides.
 */
export async function resolvePersonId(ctx: PeopleCtx, row: Record<string, unknown>, idNumber: string): Promise<ResolveOutcome> {
  const refs = peopleRefs(ctx.cfg);
  const query: Record<string, string> = { IdentityNumber: idNumber, IdentityDocumentTypeId: String(refs.identityDocumentTypeId) };
  const find = async (): Promise<VendorResult> => {
    const r = await callVendor(ctx.cfg, "people", "GET", "/People/IdentityNumber", { query, timeoutMs: 20_000, fetchImpl: ctx.fetchImpl });
    await ctx.log("GET", "/People/IdentityNumber", r);
    return r;
  };
  const fromFound = (r: VendorResult): ResolveOutcome => {
    const id = personIdFrom(r, "find");
    if (!id) return { ok: false, code: "vendor_error", http: r.http, vendorCode: "no_person_id", traceId: r.traceId, step: "find" };
    const theirs = foundIdNumber(r);
    if (theirs && theirs !== idNumber) return { ok: false, code: "manual", reason: "person_mismatch", http: r.http, vendorCode: r.vendorCode, vendorMessage: null };
    return { ok: true, personId: id, created: false };
  };

  const found = await find();
  if (found.http === 401 || found.http === 403) return { ok: false, code: "config_error", http: found.http, vendorCode: found.vendorCode, traceId: found.traceId, step: "find" };
  if (found.http === 200) return fromFound(found);
  if (found.http === 409) return { ok: false, code: "manual", reason: "duplicate_person", http: 409, vendorCode: found.vendorCode, vendorMessage: found.vendorMessage };
  if (found.http !== 404) return { ok: false, code: "vendor_error", http: found.http, vendorCode: found.vendorCode, traceId: found.traceId, step: "find" };

  const create = async (contacts: boolean): Promise<VendorResult> => {
    const body = buildCreatePerson(row, idNumber, refs, { contacts });
    const r = await callVendor(ctx.cfg, "people", "POST", "/People", { body, timeoutMs: 20_000, fetchImpl: ctx.fetchImpl });
    await ctx.log("POST", "/People", r);
    return r;
  };
  let made = await create(true);
  if (made.http === 400) made = await create(false);
  if (made.http === 401 || made.http === 403) return { ok: false, code: "config_error", http: made.http, vendorCode: made.vendorCode, traceId: made.traceId, step: "create" };
  if (made.http === 200 || made.http === 201) {
    const id = personIdFrom(made, "create");
    if (id) return { ok: true, personId: id, created: true };
    return { ok: false, code: "vendor_error", http: made.http, vendorCode: "no_person_id", traceId: made.traceId, step: "create" };
  }
  if (made.http === 409) {
    const again = await find();
    if (again.http === 200) return fromFound(again);
    return { ok: false, code: "manual", reason: "duplicate_person", http: 409, vendorCode: made.vendorCode, vendorMessage: made.vendorMessage };
  }
  if (made.http === 400) return { ok: false, code: "manual", reason: "person_rejected", http: 400, vendorCode: made.vendorCode, vendorMessage: made.vendorMessage };
  return { ok: false, code: "vendor_error", http: made.http, vendorCode: made.vendorCode, traceId: made.traceId, step: "create" };
}
