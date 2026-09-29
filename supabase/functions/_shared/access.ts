// Who may do what (consultant roles, migration 20260930). The database rules govern what a browser
// can READ; the Edge Functions use the service role and bypass them, so every staff action is
// decided here. Pure functions — tested in access_test.ts.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

export type Role = "admin" | "consultant";
export interface Member {
  role: Role;
  linkCode: string | null;
}

/** Actions that need no record. */
export const NO_RECORD_ACTIONS = ["config", "staff-list", "staff-save"];
/** Only an administrator: destroying evidence, handing out records, managing staff. */
export const ADMIN_ONLY_ACTIONS = ["delete-record", "assign", "staff-list", "staff-save"];
/**
 * EVERYTHING a consultant may do, and only on their own record (config needs none). An action
 * that is not on this list is refused for a consultant - so a new action is closed until someone
 * decides otherwise.
 */
export const CONSULTANT_ACTIONS = [
  "config", "recover", "clear-config-error", "register-consent", "run-check", "fetch-pdf", "refresh-consents",
  "record-withdrawal", "manual-upload-url", "manual-verify", "reissue-idv-link",
];

export type Access = "ok" | "inactive" | "admin_only" | "not_yours";

/**
 * - No active membership: nothing, whatever the action.
 * - Administrator: everything.
 * - Consultant: ownership is decided FIRST. A record that is not theirs (a colleague's, or an
 *   unassigned one) is "not_yours" whatever the action, so no action can be used to test whether a
 *   reference exists. On their own record: the listed actions, nothing else.
 */
export function accessFor(
  member: Member | null,
  action: string,
  userId: string,
  row?: { consultant_id?: unknown } | null,
): Access {
  if (!member) return "inactive";
  if (member.role === "admin") return "ok";
  if (NO_RECORD_ACTIONS.includes(action)) return CONSULTANT_ACTIONS.includes(action) ? "ok" : "admin_only";
  const mine = !!row && typeof row.consultant_id === "string" && row.consultant_id === userId;
  if (!mine) return "not_yours";
  return CONSULTANT_ACTIONS.includes(action) ? "ok" : "admin_only";
}

/** The "table does not exist" codes (Postgres, PostgREST schema cache) — and nothing else. */
export function isMissingTable(error: { code?: string | null } | null | undefined): boolean {
  return !!error && (error.code === "42P01" || error.code === "PGRST205");
}
/** The "function does not exist" code from PostgREST. */
export function isMissingFunction(error: { code?: string | null } | null | undefined): boolean {
  return !!error && error.code === "PGRST202";
}

/**
 * FAILS CLOSED. If staff_members cannot be read - not installed yet, a stale schema cache after a
 * restart, a permissions problem - nobody is let in. An earlier version treated a missing table as
 * "no roles yet, everyone is staff"; the same answer can appear AFTER roles are installed, where it
 * would have made every login an administrator. Migration 20260930 is therefore applied BEFORE this
 * code is deployed.
 */
export async function loadMember(sb: SupabaseClient, userId: string): Promise<Member | null> {
  const { data, error } = await sb.from("staff_members").select("role, active, link_code")
    .eq("user_id", userId).maybeSingle();
  if (error) {
    throw new Error(`${isMissingTable(error) ? "roles_not_installed" : "server_error"}: ${error.code ?? ""} ${error.message}`);
  }
  if (!data || data.active !== true) return null;
  if (data.role !== "admin" && data.role !== "consultant") return null;
  return { role: data.role, linkCode: data.link_code ?? null };
}

/** A personal link code as issued by new_link_code(): eight characters, no look-alikes. */
export function validLinkCode(v: unknown): v is string {
  return typeof v === "string" && /^[a-hj-km-np-z2-9]{8}$/.test(v);
}
