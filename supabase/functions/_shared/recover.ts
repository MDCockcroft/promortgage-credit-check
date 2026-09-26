// Stale-state recovery (C1). Runs at the start of every mm-staff and mm-client action that has a
// ref (mm-client: only for the caller's own ref), and on demand via mm-staff 'recover'. Idempotent:
// every move is a guarded transition, so two concurrent recoveries change the row once.
//
//  - check_in_flight past STALE_IN_FLIGHT_MS → check_failed 'stale_in_flight'. Never auto-retried:
//    the bureau may already have processed (and billed) the enquiry.
//  - idv_in_progress past IDV_ANSWER_WINDOW_MS → idv_failed {expired:true}, and the session
//    reference is cleared. If the reference was already consumed, an answer may still be waiting
//    on the vendor, so that case waits IDV_ANSWER_GRACE_MS longer before expiring the round.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { transition } from "./db.ts";
import { IDV_ANSWER_GRACE_MS, IDV_ANSWER_WINDOW_MS, staleState } from "./states.ts";

export type Recovered = "stale_in_flight" | "idv_expired" | null;

export const STALE_CHECK_TEXT =
  "The previous check did not complete. MortgageMAX may still have processed it — check before retrying.";

/** Mutates and returns `row` so callers keep working with the current status. */
export async function recoverStale(
  sb: SupabaseClient,
  row: Record<string, unknown>,
  now: number = Date.now(),
): Promise<{ row: Record<string, unknown>; recovered: Recovered }> {
  const ref = String(row.ref);
  const kind = staleState(row, now);

  if (kind === "check_in_flight") {
    const moved = await transition(sb, ref, ["check_in_flight"], {
      status: "check_failed", check_error_code: "stale_in_flight", check_error_text: STALE_CHECK_TEXT,
    }, "Previous credit check did not complete (recovered automatically)");
    if (moved) return { row: Object.assign(row, moved), recovered: "stale_in_flight" };
    return { row, recovered: null };
  }

  if (kind === "idv_in_progress") {
    // Claim: clear the session reference only while it is still unused.
    const { data: cleared } = await sb.from("credit_check_secrets")
      .update({ verification_request_number: null, updated_at: new Date().toISOString() })
      .eq("ref", ref).not("verification_request_number", "is", null).select("ref");
    const startedAt = row.idv_started_at ? new Date(String(row.idv_started_at)).getTime() : 0;
    const answerMayBeInFlight = (!cleared || cleared.length === 0) && Number.isFinite(startedAt) && startedAt > 0 &&
      now - startedAt <= IDV_ANSWER_WINDOW_MS + IDV_ANSWER_GRACE_MS;
    if (answerMayBeInFlight) return { row, recovered: null };
    const moved = await transition(sb, ref, ["idv_in_progress"], {
      status: "idv_failed", idv_result: { expired: true },
    }, "Identity questions expired before they were answered (recovered automatically)");
    if (moved) return { row: Object.assign(row, moved), recovered: "idv_expired" };
  }
  return { row, recovered: null };
}
