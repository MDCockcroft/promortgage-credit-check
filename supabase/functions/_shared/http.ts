// Shared HTTP plumbing for the Pro Mortgage Edge Functions.
// Ported from petcare-app/supabase/functions/manage-invite (proven in production).

const PAGES_ORIGIN = "https://mdcockcroft.github.io";
const ALLOW_ORIGINS = new Set([
  PAGES_ORIGIN,
  // Pro Mortgages SA's own address (handover row 7). Allowed before the switch, so the pages keep
  // working the moment GitHub Pages starts serving it.
  "https://check.promortgagesa.co.za",
  "http://localhost:8461",
  "http://127.0.0.1:8461",
]);

export function cors(origin: string | null): Record<string, string> {
  const allow = origin && ALLOW_ORIGINS.has(origin) ? origin : PAGES_ORIGIN;
  return {
    "Access-Control-Allow-Origin": allow,
    // apikey + x-client-info are REQUIRED: supabase-js functions.invoke() sends them on every
    // browser call; a preflight that omits them makes the browser block the request
    // (petcare outage, 2026-07-02).
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

export type ErrorCode =
  | "unauthenticated"
  | "forbidden"
  | "bad_request"
  | "invalid_state"
  | "vendor_error"
  | "vendor_timeout"
  | "config_error"
  | "server_error";

const STATUS: Record<ErrorCode, number> = {
  unauthenticated: 401,
  forbidden: 403,
  bad_request: 400,
  invalid_state: 409,
  vendor_error: 502,
  vendor_timeout: 504,
  config_error: 500,
  server_error: 500,
};

export function ok(data: unknown, origin: string | null): Response {
  return new Response(JSON.stringify({ ok: true, data }), {
    status: 200,
    headers: { ...cors(origin), "Content-Type": "application/json" },
  });
}

export function fail(
  code: ErrorCode,
  message: string,
  origin: string | null,
  extra: { vendorCode?: string | null; traceId?: string | null } = {},
): Response {
  const error: Record<string, unknown> = { code, message };
  if (extra.vendorCode) error.vendorCode = extra.vendorCode;
  if (extra.traceId) error.traceId = extra.traceId;
  return new Response(JSON.stringify({ ok: false, error }), {
    status: STATUS[code],
    headers: { ...cors(origin), "Content-Type": "application/json" },
  });
}

export function preflight(origin: string | null): Response {
  return new Response("ok", { headers: cors(origin) });
}

/** One JSON line per event. Callers must pass already-redacted values. */
export function audit(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event, at: new Date().toISOString(), ...fields }));
}
