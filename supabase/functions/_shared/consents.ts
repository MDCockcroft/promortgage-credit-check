// Consent-type selection, rendering support, hashing and the CreateConsentsRequest builder.
// BUILD-PLAN D4 (configured set, never by scope), D5 (personId = ID number), D6 (never store the
// vendor consent id), D13 (hash + version of what the client actually saw).

export const BUSINESS_GROUP = "MortgageMAX"; // ${MOBusinessGroup} → the division name, never the licensee

export interface ConsentType {
  id: string;
  name: string;
  version: string;
  active: boolean;
  declaration: string;
  contextDefinition?: Record<string, string> | null;
}

export function configuredTypeIds(raw: string | undefined): string[] {
  if (!raw) throw new Error("config_error: MM_CONSENT_TYPES is not set");
  let ids: unknown;
  try {
    ids = JSON.parse(raw);
  } catch {
    throw new Error("config_error: MM_CONSENT_TYPES is not valid JSON");
  }
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every((x) => typeof x === "string")) {
    throw new Error("config_error: MM_CONSENT_TYPES must be a non-empty JSON array of ids");
  }
  return ids as string[];
}

const sameId = (a: string, b: string) => a.toLowerCase() === b.toLowerCase(); // vendor GUID casing is mixed

/** Pick the configured types from the live list. Fails loudly if any is missing or inactive. */
export function pickTypes(all: ConsentType[], ids: string[]): ConsentType[] {
  return ids.map((id) => {
    const t = all.find((x) => sameId(x.id, id));
    if (!t) throw new Error(`config_error: consent type ${id} not returned by the vendor`);
    if (t.active !== true) throw new Error(`config_error: consent type ${id} is inactive`);
    return t;
  });
}

/** Substitute template variables the API serves unrendered. */
export function renderDeclaration(declaration: string): string {
  return declaration.replaceAll("${MOBusinessGroup}", BUSINESS_GROUP);
}

/** LF-normalised, trimmed — so CRLF vs LF never changes the hash. */
export function normaliseForHash(s: string): string {
  return s.replace(/\r\n?/g, "\n").trim();
}

export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function declarationHash(t: ConsentType): Promise<string> {
  return sha256Hex(normaliseForHash(renderDeclaration(t.declaration)));
}

/** Fill the consent's context from the type's contextDefinition (P10 validates it). */
export function contextFor(t: ConsentType): Record<string, string> {
  const ctx: Record<string, string> = {};
  for (const [key, template] of Object.entries(t.contextDefinition ?? {})) {
    if (key === "MOBusinessGroup" || template === "${MOBusinessGroup}") ctx[key] = BUSINESS_GROUP;
    else throw new Error(`config_error: consent type ${t.id} needs unknown context key ${key}`);
  }
  return ctx;
}

export interface PresentedConsent {
  id: string;
  version: string;
  hash: string;
}

/**
 * Verify the types the client saw still match what we are about to register.
 * Returns the list of stale ids (empty = safe to post).
 */
export async function staleAgainst(presented: PresentedConsent[], live: ConsentType[]): Promise<string[]> {
  const stale: string[] = [];
  for (const p of presented) {
    const t = live.find((x) => sameId(x.id, p.id));
    if (!t || t.version !== p.version || (await declarationHash(t)) !== p.hash) stale.push(p.id);
  }
  return stale;
}

export function buildCreateConsents(args: {
  personId: string;
  apiClientId: string;
  ref: string;
  types: ConsentType[];
  granted: boolean;
  createdBy: string;
}) {
  if (!args.personId) throw new Error("bad_request: personId is empty");
  return {
    personId: args.personId,
    consents: args.types.map((t) => ({
      apiClientId: args.apiClientId,
      consentTypeId: t.id,
      createdBy: args.createdBy,
      granted: args.granted,
      sourceURN: `urn:promortgagesa:credit-check:${args.ref}`,
      context: contextFor(t),
    })),
  };
}

/**
 * Read a GET /Consents?PersonId= snapshot against the configured type ids (case-insensitive).
 * - allGranted: every id has a record with granted === true (C7 — required before a paid check).
 * - anyRefused: some id has a record with granted === false — a withdrawal or decline already on
 *   the vendor register, which a new registration would silently overwrite (C6d, P11).
 * A malformed snapshot (not an array) is never "granted".
 */
export function consentGrantState(snapshot: unknown, typeIds: string[]): { allGranted: boolean; anyRefused: boolean } {
  const recs = Array.isArray(snapshot) ? snapshot as Array<Record<string, unknown>> : [];
  const forType = (id: string) => recs.filter((c) => c && typeof c.consentTypeId === "string" && sameId(c.consentTypeId, id));
  return {
    allGranted: Array.isArray(snapshot) && typeIds.length > 0 &&
      typeIds.every((id) => forType(id).some((c) => c.granted === true)),
    anyRefused: typeIds.some((id) => forType(id).some((c) => c.granted === false)),
  };
}

export interface WithdrawItem {
  id: string;
  context: Record<string, string>;
}

/**
 * CreateConsentsRequest with granted=false for exactly the types that were registered (not
 * today's configuration). No active check: the vendor accepts granted=false for inactive types (P2).
 */
export function buildWithdrawConsents(args: {
  personId: string;
  apiClientId: string;
  ref: string;
  items: WithdrawItem[];
  createdBy: string;
}) {
  if (!args.personId) throw new Error("bad_request: personId is empty");
  if (args.items.length === 0) throw new Error("bad_request: nothing to withdraw");
  return {
    personId: args.personId,
    consents: args.items.map((it) => ({
      apiClientId: args.apiClientId,
      consentTypeId: it.id,
      createdBy: args.createdBy,
      granted: false,
      sourceURN: `urn:promortgagesa:credit-check:${args.ref}`,
      context: it.context,
    })),
  };
}
