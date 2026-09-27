// SMS gateway for the consent code (BUILD-PLAN §6 — the code IS the consent evidence).
// Provider: SMSPortal REST v3 (https://docs.smsportal.com/reference/bulkmessages_postv3).
// The account belongs to Pro Mortgages SA; its Client ID + API secret live only in Edge Function
// secrets (never in the browser, the repo or a log line).
//
// SMS_MODE:
//   mock — no network. The code is returned to the browser (shown on screen). Default.
//   test — real SMSPortal call with testMode:true: proves the credentials and payload, sends
//          nothing, costs nothing. The code is still shown on screen.
//   live — real send. The code NEVER leaves the server except inside the SMS.
// A production MortgageMAX environment refuses to run with anything but live (smsGuard).

export type SmsMode = "mock" | "test" | "live";

export interface SmsConfig {
  mode: SmsMode;
  clientId?: string;
  apiSecret?: string;
  senderId?: string; // ≤ 11 chars; best effort — the network decides
  brand: string; // name the SMS opens with
  baseUrl: string;
  dailyMax: number; // circuit breaker: all sends, all records, rolling 24 h
}

export interface SmsResult {
  ok: boolean;
  status: "sent" | "failed" | "unknown"; // unknown = timed out; it may still arrive
  http: number; // 0 = network error / timeout
  eventId: string | null;
  cost: number | null;
  errorCode: string | null; // provider vocabulary, never the destination or the text
  latencyMs: number;
}

/** Limits the claim RPC enforces (claim_otp_send). */
export const OTP_COOLDOWN_S = 60;
export const OTP_FAILED_RETRY_S = 15; // after a failed send (record_sms_result backdates otp_sent_at by 45 s)
export const OTP_MAX_SENDS = 3; // the first code + two resends, per application
export const OTP_MAX_PER_CELL_24H = 5; // across every application for one cellphone number

export function smsConfigFromEnv(get: (k: string) => string | undefined = (k) => Deno.env.get(k)): SmsConfig {
  const raw = (get("SMS_MODE") ?? "mock").trim().toLowerCase();
  if (raw !== "mock" && raw !== "test" && raw !== "live") throw new Error(`config_error: SMS_MODE must be mock, test or live`);
  const mode = raw as SmsMode;
  const clientId = get("SMSPORTAL_CLIENT_ID")?.trim() || undefined;
  const apiSecret = get("SMSPORTAL_API_SECRET")?.trim() || undefined;
  if (mode !== "mock" && (!clientId || !apiSecret)) {
    throw new Error("config_error: missing secret SMSPORTAL_CLIENT_ID / SMSPORTAL_API_SECRET");
  }
  const senderId = get("SMS_SENDER_ID")?.trim() || undefined;
  if (senderId && senderId.length > 11) throw new Error("config_error: SMS_SENDER_ID is longer than 11 characters");
  const dailyMax = Number(get("SMS_DAILY_MAX") ?? "300");
  return {
    mode, clientId, apiSecret, senderId,
    brand: get("SMS_BRAND")?.trim() || "Pro Mortgages SA",
    baseUrl: (get("SMSPORTAL_BASE_URL") ?? "https://rest.smsportal.com").replace(/\/+$/, ""),
    dailyMax: Number.isFinite(dailyMax) && dailyMax > 0 ? Math.floor(dailyMax) : 300,
  };
}

/**
 * Production must never show the code on screen. MMAX_ENV is 'uat' today; anything that is not
 * plainly a test environment counts as production.
 */
export function smsGuard(sms: SmsConfig, mmEnv: string): string | null {
  const testEnv = /^(uat|test|sandbox|dev)$/i.test(mmEnv.trim());
  if (!testEnv && sms.mode !== "live") return `SMS_MODE is ${sms.mode} but MMAX_ENV is ${mmEnv}`;
  return null;
}

// GSM 03.38 basic set (+ the extension table, which costs two septets). Anything else turns the
// whole SMS into UCS-2 (70 chars) — a curly apostrophe would quietly double the cost.
const GSM7 = "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM7_EXT = "^{}\\[~]|€";

export function gsm7Length(s: string): number | null {
  let n = 0;
  for (const ch of s) {
    if (GSM7.includes(ch)) n += 1;
    else if (GSM7_EXT.includes(ch)) n += 2;
    else return null;
  }
  return n;
}

/** The consent-code SMS. Must stay one GSM-7 segment (≤ 160); sms_test.ts holds it to that. */
export function otpMessage(brand: string, code: string): string {
  return `${brand}: your consent code is ${code}. Entering it on the form confirms your consent ` +
    `to a credit check. It expires in 10 minutes.`;
}

export async function sendSms(
  cfg: SmsConfig,
  msg: { to: string; text: string; customerId: string },
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<SmsResult> {
  const started = Date.now();
  if (cfg.mode === "mock") {
    return { ok: true, status: "sent", http: 200, eventId: `mock-${crypto.randomUUID().slice(0, 8)}`, cost: 0, errorCode: null, latencyMs: 0 };
  }
  const body = {
    sendOptions: {
      testMode: cfg.mode === "test",
      campaignName: "Consent code",
      validityPeriod: 1, // hours — the code is dead after 10 minutes anyway
      ...(cfg.senderId ? { senderId: cfg.senderId } : {}),
    },
    messages: [{ destination: msg.to, content: msg.text, customerId: msg.customerId }],
  };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 10_000);
  const f = opts.fetchImpl ?? fetch;
  let http = 0;
  let text = "";
  try {
    const res = await f(`${cfg.baseUrl}/v3/BulkMessages`, {
      method: "POST",
      headers: {
        "Authorization": `Basic ${btoa(`${cfg.clientId}:${cfg.apiSecret}`)}`,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    http = res.status;
    text = (await res.text()).slice(0, 8_000);
  } catch (e) {
    const timedOut = e instanceof DOMException && e.name === "AbortError";
    // A timeout may still have been accepted by the provider — 'unknown', not 'failed'.
    return { ok: false, status: timedOut ? "unknown" : "failed", http: 0, eventId: null, cost: null, errorCode: timedOut ? "timeout" : "network", latencyMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
  return { ...interpretSend(http, text), latencyMs: Date.now() - started };
}

/** Success = HTTP 200, no send-wide errors, no per-message faults. Pure, for the tests. */
export function interpretSend(http: number, text: string): Omit<SmsResult, "latencyMs"> {
  let d: Record<string, unknown> | null = null;
  try {
    const j = JSON.parse(text);
    if (j && typeof j === "object") d = j as Record<string, unknown>;
  } catch { /* not JSON */ }

  const firstError = (): string | null => {
    const errs = Array.isArray(d?.errors) ? d!.errors as Array<Record<string, unknown>> : [];
    const e = errs.find((x) => x && (x.errorCode || x.errorMessage));
    if (e) return String(e.errorCode ?? e.errorMessage).slice(0, 80);
    // Authentication failures come back as a bare {errorCode, errorMessage}.
    if (d?.errorCode) return String(d.errorCode).slice(0, 80);
    return null;
  };

  if (http !== 200) {
    return { ok: false, status: "failed", http, eventId: null, cost: null, errorCode: firstError() ?? `http_${http}` };
  }
  const sr = (d?.sendResponse ?? null) as Record<string, unknown> | null;
  const report = (sr?.errorReport ?? null) as Record<string, unknown> | null;
  const faults = Array.isArray(report?.faults) ? report!.faults as Array<Record<string, unknown>> : [];
  const counted = ["noNetwork", "noContents", "contentToLong", "duplicates", "optedOuts"]
    .find((k) => typeof report?.[k] === "number" && (report![k] as number) > 0);
  let err = firstError();
  if (!err && faults.length) err = String(faults[0].status ?? faults[0].errorMessage ?? "fault").slice(0, 80);
  if (!err && counted) err = counted;
  if (!err && !sr) err = "unexpected_body";
  const eventId = sr?.eventId != null ? String(sr.eventId) : null;
  const cost = typeof sr?.cost === "number" ? sr.cost as number : null;
  if (err) return { ok: false, status: "failed", http, eventId, cost, errorCode: err };
  return { ok: true, status: "sent", http, eventId, cost, errorCode: null };
}
