// Manual identity verification — the only route to a credit check without passing the identity
// questions (MortgageMAX, 2026-09-28: IDV is mandatory; manual = ID copy uploaded + the consultant's
// Experian attestation). Shared by mm-staff and checked for parity against assets/store.js.

/**
 * The consultant's statement, VERBATIM from MortgageMAX (Bennie Vermeulen, 2026-09-28) — Experian
 * audits it. Never paraphrase or fix the wording; any change is a new version.
 */
export const ATTESTATION = {
  version: "experian-manual-2026-09-28",
  text: "I hereby confirm that I have read and understood the Experian Terms and conditions and that I have " +
    "verified the customer's identity by validating their identity documents / driver's licence and uploaded " +
    "it to the system. I also presented/read out the Customer Consent for their consideration and acceptance " +
    "before requesting their credit information via the Experian System.",
} as const;

export const ID_DOC_BUCKET = "id-documents";
export const ID_DOC_MAX_BYTES = 10 * 1024 * 1024; // matches the bucket's file_size_limit
export const ID_DOC_TYPES: Record<string, string> = { "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png" };

/** Statuses where consent is registered and no identity step or check is running. */
const MANUAL_FROM = ["consent_registered", "idv_failed", "idv_unavailable", "idv_waived"];

/**
 * May a consultant verify this record's identity manually? Never for passports (Experian supports
 * SA IDs only — foreign nationals get no credit check at all), never around a withdrawal, stale
 * wording or a registration problem. `manual_required` qualifies only for the identity-round limit,
 * the one exit that keeps consent_registered_at (every consent-side exit clears it).
 */
export function manualVerifyCheck(row: Record<string, unknown>): { ok: true } | { ok: false; reason: string } {
  if (row.id_type !== "said") return { ok: false, reason: "not_sa_id" };
  if (row.consent_withdrawn_at) return { ok: false, reason: "withdrawn" };
  const status = String(row.status ?? "");
  if (MANUAL_FROM.includes(status)) return { ok: true };
  if (status === "manual_required" && row.consent_registered_at) return { ok: true };
  return { ok: false, reason: `status_${status}` };
}

/** Server-chosen object path for a record's ID copy; the browser never names it. */
export function idDocPath(ref: string, contentType: string, id: string = crypto.randomUUID()): string | null {
  const ext = ID_DOC_TYPES[contentType];
  return ext ? `${ref}/${id}.${ext}` : null;
}

/** The path must be one idDocPath() could have issued for THIS ref. */
export function validIdDocPath(ref: string, path: unknown): path is string {
  if (typeof path !== "string" || !path.startsWith(`${ref}/`)) return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(pdf|jpg|png)$/.test(path.slice(ref.length + 1));
}

/** Content type from the file's first bytes — the upload's declared type is not trusted. */
export function sniffDocType(b: Uint8Array): string | null {
  if (b.length >= 5 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2d) return "application/pdf";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
    b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "image/png";
  return null;
}

export async function sha256HexBytes(b: Uint8Array<ArrayBuffer>): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", b));
  return Array.from(d, (x) => x.toString(16).padStart(2, "0")).join("");
}
