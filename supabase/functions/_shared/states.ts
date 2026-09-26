// The credit-check permission rule, shared by mm-staff and checked for parity against
// assets/store.js (states_test.ts) so the admin buttons can never disagree with the server.
export type IdvMode = "off" | "optional" | "required";

/** Which statuses may start a credit check, per IDV mode (BUILD-PLAN §2). */
export function allowedFrom(mode: IdvMode, force: boolean): string[] {
  const retry = ["check_failed"];
  if (mode === "required") return ["idv_passed", ...retry];
  if (mode === "optional") {
    return force
      ? ["idv_passed", "consent_registered", "idv_failed", "idv_unavailable", "idv_waived", ...retry]
      : ["idv_passed", ...retry];
  }
  return ["consent_registered", "idv_waived", "idv_passed", ...retry]; // off
}

/** Every status the DB CHECK constraint allows (migration 20260926_mortgagemax.sql). */
export const ALL_STATUSES = [
  "awaiting_otp", "consent_confirmed", "consent_registered",
  "idv_in_progress", "idv_passed", "idv_failed", "idv_unavailable", "idv_waived",
  "check_in_flight", "report_ready", "check_failed",
  "consent_withdrawn", "manual_required", "expired", "config_error",
  "report_requested",
];

// ---------------------------------------------------------------------------------------------
// Stale-state recovery (C1) — decided here, applied by recover.ts in both functions.
// ---------------------------------------------------------------------------------------------
/** A check still "running" after this was killed mid-call (wall-clock limit, crash, deploy). */
export const STALE_IN_FLIGHT_MS = 5 * 60 * 1000;
/** Server-side IDV answer window (the browser shows 5:00; one minute of slack). */
export const IDV_ANSWER_WINDOW_MS = 6 * 60 * 1000;
/**
 * Extra time before expiring a round whose session reference was already consumed: an answer
 * submitted just inside the window may still be waiting on /Idv/checkAnswers (25 s timeout).
 */
export const IDV_ANSWER_GRACE_MS = 2 * 60 * 1000;

const ms = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const t = new Date(v as string).getTime();
  return Number.isFinite(t) ? t : null;
};

/** Which recovery (if any) this row needs now. A missing start time counts as stale. */
export function staleState(row: Record<string, unknown>, now: number): "check_in_flight" | "idv_in_progress" | null {
  if (row.status === "check_in_flight") {
    const t = ms(row.check_started_at);
    return t === null || now - t > STALE_IN_FLIGHT_MS ? "check_in_flight" : null;
  }
  if (row.status === "idv_in_progress") {
    const t = ms(row.idv_started_at);
    return t === null || now - t > IDV_ANSWER_WINDOW_MS ? "idv_in_progress" : null;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Leaving config_error (C2): where the record really was, derived from its own data.
// ---------------------------------------------------------------------------------------------
export function configErrorTarget(
  row: Record<string, unknown>,
  idvMode: IdvMode,
): { status: string; patch: Record<string, unknown> } {
  const has = (v: unknown) => v !== null && v !== undefined && v !== "";
  if (has(row.report_json)) return { status: "report_ready", patch: {} };
  if (has(row.check_started_at)) {
    return {
      status: "check_failed",
      patch: {
        check_error_code: "config_error_cleared",
        check_error_text: "A system error stopped the previous credit check. Check MortgageMAX before retrying.",
      },
    };
  }
  if (!has(row.consent_registered_at)) return { status: "consent_confirmed", patch: {} };
  if (has(row.idv_passed_at)) return { status: "idv_passed", patch: {} };
  if (Number(row.idv_attempts ?? 0) > 0) return { status: "idv_failed", patch: {} };
  return { status: idvMode === "off" ? "idv_waived" : "consent_registered", patch: {} };
}
