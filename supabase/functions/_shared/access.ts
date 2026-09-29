// Who may do what (consultant roles, migration 20260930). The database rules govern what a browser
// can READ; the Edge Functions use the service role and bypass them, so every staff action is
// decided here. Pure functions — tested in access_test.ts.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

export type Role = "admin" | "consultant";
export interface Member {
  role: Role;
  linkCode: string | null;
  /** True when staff_members does not exist yet (migration not applied): behave as before it. */
  legacy?: boolean;
}

/** Actions that need no record. */
export const NO_RECORD_ACTIONS = ["config", "staff-list", "staff-save"];
/** Only an administrator: destroying evidence, handing out records, managing staff. */
export const ADMIN_ONLY_ACTIONS = ["delete-record", "assign", "staff-list", "staff-save"];

export type Access = "ok" | "inactive" | "admin_only" | "not_yours";

/**
 * - No active membership: nothing, whatever the action.
 * - Administrator: everything.
 * - Consultant: the actions that are not administrator-only, and only on a record assigned to them.
 *   An unassigned record belongs to nobody yet, so a consultant cannot act on it either.
 */
export function accessFor(
  member: Member | null,
  action: string,
  userId: string,
  row?: { consultant_id?: unknown } | null,
): Access {
  if (!member) return "inactive";
  if (member.role === "admin") return "ok";
  if (ADMIN_ONLY_ACTIONS.includes(action)) return "admin_only";
  if (NO_RECORD_ACTIONS.includes(action)) return "ok";
  return row && typeof row.consultant_id === "string" && row.consultant_id === userId ? "ok" : "not_yours";
}

/** The "table does not exist" codes (Postgres, PostgREST schema cache) — and nothing else. */
export function isMissingTable(error: { code?: string | null } | null | undefined): boolean {
  return !!error && (error.code === "42P01" || error.code === "PGRST205");
}
/** The "function does not exist" code from PostgREST. */
export function isMissingFunction(error: { code?: string | null } | null | undefined): boolean {
  return !!error && error.code === "PGRST202";
}

export async function loadMember(sb: SupabaseClient, userId: string): Promise<Member | null> {
  const { data, error } = await sb.from("staff_members").select("role, active, link_code")
    .eq("user_id", userId).maybeSingle();
  if (error) {
    // Before migration 20260930 there are no roles: every signed-in user is staff, as until now.
    if (isMissingTable(error)) return { role: "admin", linkCode: null, legacy: true };
    throw new Error(`server_error: ${error.message}`);
  }
  if (!data || data.active !== true) return null;
  if (data.role !== "admin" && data.role !== "consultant") return null;
  return { role: data.role, linkCode: data.link_code ?? null };
}

/** A personal link code as issued by new_link_code(): six characters, no look-alikes. */
export function validLinkCode(v: unknown): v is string {
  return typeof v === "string" && /^[a-hj-km-np-z2-9]{6}$/.test(v);
}
