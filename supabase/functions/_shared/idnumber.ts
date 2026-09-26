// Identity-number hygiene for the vendor calls (BUILD-PLAN D5, D11). Pure — no env, no I/O.
// The browser (assets/store.js validSaId) applies the same rule on the form; this is the server's
// copy, because an anonymous RPC payload never has to pass through the form.

/** Luhn total over the digits, rightmost digit first (the check digit is not doubled). */
function luhnTotal(digits: string): number {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum;
}

/** 13 digits, a plausible YYMMDD month/day, and a valid Luhn check digit. */
export function validSaId(id: unknown): boolean {
  if (typeof id !== "string" || !/^\d{13}$/.test(id)) return false;
  const m = Number(id.slice(2, 4)), d = Number(id.slice(4, 6));
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  return luhnTotal(id) % 10 === 0;
}

const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/**
 * The personId / idNumber sent to MortgageMAX: ALWAYS the column that matches id_type (C6b) —
 * never mm_person_id, which the submit RPC fills from whichever number was supplied.
 * Returns "" when the matching column is empty.
 */
export function personIdFor(row: Record<string, unknown>): string {
  if (row.id_type === "said") return s(row.id_number);
  if (row.id_type === "passport") return s(row.passport_number);
  return "";
}

/**
 * Registration-time hygiene (C6b). null = acceptable; otherwise the audit reason for routing the
 * record to manual_required. Passport rows are gated separately (ALLOW_PASSPORT).
 */
export function idProblem(row: Record<string, unknown>): string | null {
  if (row.id_type === "said") {
    const id = s(row.id_number);
    if (!validSaId(id) || s(row.mm_person_id) !== id) return "ID number could not be validated";
    return null;
  }
  if (row.id_type === "passport") {
    return s(row.passport_number) ? null : "ID number could not be validated";
  }
  return "ID number could not be validated";
}

/** C15: the IDV idType the bureau expects for this row. */
export function idvIdType(row: Record<string, unknown>): "SAID" | "PASSPORT" {
  return row.id_type === "passport" ? "PASSPORT" : "SAID";
}
