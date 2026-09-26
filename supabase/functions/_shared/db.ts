// Service-role database helpers shared by mm-client and mm-staff.
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { type Api, logBodyHead, redact, type VendorResult } from "./mmax.ts";

export function serviceClient(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL");
  // Legacy name is still injected on new-key projects; fall back to the new secret-keys JSON.
  let key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!key) {
    try {
      const keys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}");
      key = keys.default ?? Object.values(keys)[0] as string | undefined;
    } catch { /* handled below */ }
  }
  if (!url || !key) throw new Error("config_error: service credentials not injected");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Write every vendor exchange, PII-redacted, BEFORE acting on it (D9). Never throws.
 * Credit-report, PDF and IDV success bodies are never persisted — see logBodyHead (C11).
 */
export async function logCall(
  sb: SupabaseClient,
  args: {
    ref: string | null;
    requestId: string;
    api: Api;
    method: string;
    path: string;
    result: VendorResult;
    redactValues: Array<string | null | undefined>;
    env: string;
  },
): Promise<void> {
  const { result: r } = args;
  const { error } = await sb.from("mm_api_log").insert({
    ref: args.ref,
    request_id: args.requestId,
    api: args.api,
    method: args.method,
    path_redacted: redact(args.path, args.redactValues),
    http_status: r.http,
    content_type: r.contentType.slice(0, 120),
    body_head: logBodyHead(args.api, r, args.redactValues),
    vendor_code: r.vendorCode,
    trace_id: r.traceId,
    latency_ms: r.latencyMs,
    mm_env: args.env,
  });
  if (error) console.error(JSON.stringify({ event: "mm_api_log_failed", message: error.message }));
}

export function auditEntry(event: string) {
  return { at: Date.now(), event };
}

/**
 * Conditional status transition: one UPDATE statement, so it is atomic (D9).
 * Returns the updated row, or null when the row was not in an allowed state.
 */
export async function transition(
  sb: SupabaseClient,
  ref: string,
  allowedFrom: string[],
  patch: Record<string, unknown>,
  event?: string,
): Promise<Record<string, unknown> | null> {
  if (event) {
    const { data: cur } = await sb.from("credit_checks").select("audit").eq("ref", ref).maybeSingle();
    const audit = Array.isArray(cur?.audit) ? cur!.audit : [];
    patch = { ...patch, audit: [...audit, auditEntry(event)] };
  }
  const { data, error } = await sb.from("credit_checks").update(patch)
    .eq("ref", ref).in("status", allowedFrom).select().maybeSingle();
  if (error) throw new Error(`server_error: ${error.message}`);
  return data;
}
