// The ONE parser for CreditCheckResponseDto → the Tier 1 verdict the consultant sees first.
// Computed server-side at write time and stored as credit_checks.report_summary, so the admin page
// never re-implements it (no drift). BUILD-PLAN §3 Step 9 + trap "never Boolean(str)".

export type Flag = "yes" | "no" | "unknown";

const YES = new Set(["Y", "YES", "TRUE", "1", "T"]);
const NO = new Set(["N", "NO", "FALSE", "0", "F", ""]);

/** Vendor flags are strings of unknown vocabulary. Never coerce with Boolean(): "false" is truthy. */
export function flag(v: unknown): Flag {
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (v === null || v === undefined) return "unknown";
  const s = String(v).trim().toUpperCase();
  if (YES.has(s)) return "yes";
  if (NO.has(s)) return "no";
  return "unknown";
}

/** "1 450 000", "R1,450,000.00", 642 → number; anything unparseable → null. */
export function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const cleaned = v.replace(/[R\s,]/gi, "");
  if (cleaned === "" || !/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  return Number(cleaned);
}

const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
/** C10: a section the bureau did not return is unknown (null), never a clean "0". */
const count = (v: unknown): number | null => (Array.isArray(v) ? v.length : null);
const o = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};

export interface ReportSummary {
  score: number | null;
  riskType: string | null;
  riskColour: string | null; // css rgb() or null
  rag: string | null;
  thinFile: Flag;
  declineReasons: string[];
  flags: {
    deceased: Flag;
    fraud: Flag;
    dispute: Flag;
    sequestration: Flag;
    debtReview: Flag;
    debtReviewRequested: Flag;
    debtReviewGranted: Flag;
  };
  // null = the bureau section was absent (or not a list); 0 = present and empty.
  counts: {
    judgements: number | null;
    adverse: number | null;
    publicDefaults: number | null;
    debtRestructures: number | null;
    notices: number | null;
    collections: number | null;
  };
  affordability: { present: boolean; success: boolean | null; amount: number | null; error: string | null };
  enquiryId: string | null;
}

export function summarise(dto: unknown): ReportSummary {
  const d = o(dto);
  const root = o(d.experianCreditCheckData);
  const res = o(root.cC_RESULTS);
  const cs = o(arr(res.enqCC_CompuSCORE)[0]);
  const aff = o(d.affordabilityResponseModel);
  const hasAff = Object.keys(aff).length > 0;

  const r = num(cs.risK_COLOUR_R), g = num(cs.risK_COLOUR_G), b = num(cs.risK_COLOUR_B);
  const declineReasons = ["declinE_R_1", "declinE_R_2", "declinE_R_3", "declinE_R_4", "declinE_R_5"]
    .map((k) => String(cs[k] ?? "").trim()).filter((s) => s !== "");

  return {
    score: num(cs.score) ?? num(aff.score),
    riskType: typeof cs.risK_TYPE === "string" && cs.risK_TYPE ? cs.risK_TYPE : null,
    riskColour: r !== null && g !== null && b !== null ? `rgb(${r}, ${g}, ${b})` : null,
    rag: typeof aff.ragIndicator === "string" && aff.ragIndicator ? aff.ragIndicator : null,
    thinFile: cs.thiN_FILE_INDICATOR !== undefined ? flag(cs.thiN_FILE_INDICATOR) : flag(aff.thinFile),
    declineReasons,
    flags: {
      deceased: flag(aff.deceased),
      fraud: flag(aff.fraud),
      dispute: flag(aff.dispute),
      sequestration: flag(aff.sequestration),
      debtReview: flag(aff.debtReview),
      debtReviewRequested: flag(aff.debtReviewRequested),
      debtReviewGranted: flag(aff.debtReviewGranted),
    },
    counts: {
      judgements: count(res.enqCC_JUDGEMENTS),
      adverse: count(res.enqCC_ADVERSE),
      publicDefaults: count(res.enqCC_PUBLIC_DEFAULTS),
      debtRestructures: count(res.enqCC_DEBT_RESTRUCT),
      notices: count(res.enqCC_NOTICES),
      collections: count(res.enqCC_COLLECTIONS),
    },
    // Affordability is a separately sold product — may be absent or errored on this subscription.
    affordability: {
      present: hasAff,
      success: typeof aff.success === "boolean" ? aff.success : null,
      amount: num(aff.amount),
      error: typeof aff.error === "string" && aff.error ? aff.error : null,
    },
    enquiryId: typeof root.cC_ENQUIRY_ID === "string" ? root.cC_ENQUIRY_ID : null,
  };
}

/** Byte search for an encrypted PDF (no PDF library — Edge CPU budget). */
export function pdfIsEncrypted(bytes: Uint8Array): boolean {
  const needle = new TextEncoder().encode("/Encrypt");
  outer: for (let i = 0; i <= bytes.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (bytes[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
