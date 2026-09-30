// MortgageMax / BetterLife API client (BLOS Credit Management v1 + BT Consent Management v3).
// Evidence for every rule here: ~/ARRABON Services/Systems/Pro Mortgages SA - Credit Check/
// uat-probe-results.md (probes T1–T3, P1–P12). BUILD-PLAN.md §1 D1, §4 traps.
//
// Rules:
//  - Auth = Ocp-Apim-Subscription-Key header ONLY (never the query variant — it leaks into logs).
//    Optional Entra bearer activates only when tenant + secret are configured (D1 production hedge).
//  - Branch on HTTP status first; read the body as TEXT and sniff it — the vendor returns JSON,
//    JSON-encoded strings, bare text/plain (P3), base64 PDFs and URLs (P6), often mislabelled.
//  - Errors arrive inside HTTP 200 in several vocabularies; success predicates live here, once.
//  - Exactly nine paths may ever be called. The sandbox key can also WRITE consent types.
//  - personId / idNumber never appear in any log line.

export type Api = "credit" | "consent";
export type BodyKind = "empty" | "json" | "json_string" | "text" | "pdf_bytes" | "pdf_base64" | "url";

export interface MmConfig {
  creditBaseUrl: string;
  consentBaseUrl: string;
  subscriptionKey: string;
  apiClientId: string;
  env: string;
  oauth?: { tenantId: string; clientId: string; clientSecret: string };
}

export interface VendorResult {
  http: number; // 0 = network error / timeout
  contentType: string;
  kind: BodyKind;
  data: unknown; // parsed JSON, decoded string, or null
  text: string; // raw body text (bounded)
  vendorCode: string | null;
  vendorMessage: string | null;
  traceId: string | null;
  latencyMs: number;
  timedOut: boolean;
}

// ---------------------------------------------------------------------------
// Configuration (read lazily so unit tests need no --allow-env)
// ---------------------------------------------------------------------------
export function configFromEnv(get: (k: string) => string | undefined = (k) => Deno.env.get(k)): MmConfig {
  const need = (k: string) => {
    const v = get(k);
    if (!v) throw new Error(`config_error: missing secret ${k}`);
    return v;
  };
  const tenantId = get("MMAX_OAUTH_TENANT_ID");
  const clientSecret = get("MMAX_OAUTH_CLIENT_SECRET");
  return {
    creditBaseUrl: need("MMAX_CREDIT_BASE_URL").replace(/\/+$/, ""),
    consentBaseUrl: need("MMAX_CONSENT_BASE_URL").replace(/\/+$/, ""),
    subscriptionKey: need("MMAX_SUBSCRIPTION_KEY"),
    apiClientId: need("MMAX_API_CLIENT_ID"),
    env: get("MMAX_ENV") ?? "uat",
    oauth: tenantId && clientSecret
      ? { tenantId, clientId: need("MMAX_API_CLIENT_ID"), clientSecret }
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// Path allow-list — nothing else is ever called (BUILD-PLAN §4)
// ---------------------------------------------------------------------------
const ALLOWED: Array<[Api, string, RegExp]> = [
  ["consent", "GET", /^\/ConsentTypes$/],
  ["consent", "GET", /^\/ConsentTypes\/[0-9A-Fa-f-]{36}$/],
  ["consent", "POST", /^\/Consents$/],
  ["consent", "GET", /^\/Consents$/],
  ["consent", "POST", /^\/Consents\/Files$/],
  ["credit", "POST", /^\/Idv\/getQuestions$/],
  ["credit", "POST", /^\/Idv\/checkAnswers$/],
  ["credit", "POST", /^\/CreditCheck\/full$/],
  ["credit", "GET", /^\/CreditCheck\/getDocument\/[^/]+\/(true|false)\/(true|false)$/],
];

export function isAllowed(api: Api, method: string, path: string): boolean {
  return ALLOWED.some(([a, m, re]) => a === api && m === method.toUpperCase() && re.test(path));
}

// ---------------------------------------------------------------------------
// Body sniffing
// ---------------------------------------------------------------------------
export function parseBody(text: string): { kind: BodyKind; data: unknown } {
  const t = text.trim();
  if (t === "") return { kind: "empty", data: null };
  if (t.startsWith("%PDF")) return { kind: "pdf_bytes", data: null };
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      return { kind: "json", data: JSON.parse(t) };
    } catch { /* fall through to text */ }
  }
  if (t.startsWith('"')) {
    try {
      const s = JSON.parse(t);
      if (typeof s === "string") return classifyString(s, "json_string");
    } catch { /* fall through */ }
  }
  return classifyString(t, "text");
}

function classifyString(s: string, fallback: BodyKind): { kind: BodyKind; data: unknown } {
  if (s.startsWith("JVBERi0")) return { kind: "pdf_base64", data: s }; // base64 of "%PDF-"
  if (/^https?:\/\//.test(s)) return { kind: "url", data: s };
  return { kind: fallback, data: s };
}

// ---------------------------------------------------------------------------
// Error vocabulary normalisation (five shapes observed)
// ---------------------------------------------------------------------------
export function extractVendorError(
  http: number,
  kind: BodyKind,
  data: unknown,
  text: string,
): { vendorCode: string | null; vendorMessage: string | null; traceId: string | null } {
  let vendorCode: string | null = null;
  let vendorMessage: string | null = null;
  let traceId: string | null = null;

  if (kind === "json" && data && typeof data === "object" && !Array.isArray(data)) {
    const d = data as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v : null);
    traceId = str(d.traceId);
    // (2) ASP.NET ProblemDetails — P1, P10
    if (d.errors && typeof d.errors === "object") {
      vendorCode = "validation";
      vendorMessage = Object.entries(d.errors as Record<string, string[]>)
        .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join("; ") : v}`)
        .join(" | ");
    } else if (typeof d.statusCode === "number" && str(d.message)) {
      // (1) APIM gateway — T1
      vendorCode = `gateway_${d.statusCode}`;
      vendorMessage = str(d.message);
    } else {
      // (4)/(5) in-body DTO errors — CreditCheckResponseDto, VerificationResultDto,
      // SimpleCreditCheckResponseDto, and the undocumented IDV responseCode (T3)
      vendorCode = str(d.errorCode) ?? (str(d.responseCode) && d.responseCode !== "Success" ? str(d.responseCode) : null);
      vendorMessage = str(d.errorString) ?? str(d.errorCodeDescription) ?? str(d.errorDescription) ??
        str(d.responseMessage) ?? str(d.statusCodeDescription);
    }
  } else if (http >= 400 && (kind === "text" || kind === "json_string")) {
    // (3) bare text on a non-2xx — P3 "No Credit Check with Id '', "
    vendorCode = `http_${http}`;
    vendorMessage = text.trim().replace(/,\s*$/, "");
  } else if (http >= 400) {
    vendorCode = `http_${http}`;
  }
  return { vendorCode, vendorMessage, traceId };
}

// ---------------------------------------------------------------------------
// Success predicates — the ONLY place success is decided (BUILD-PLAN Step 4)
// ---------------------------------------------------------------------------
const obj = (d: unknown) => (d && typeof d === "object" && !Array.isArray(d) ? d as Record<string, unknown> : null);
const blank = (v: unknown) => v === null || v === undefined || (typeof v === "string" && v.trim() === "");

/**
 * Every field of the spec's QuestionData is nullable. A question the browser cannot render, or the
 * server cannot validate an answer against, must never put a record into idv_in_progress.
 */
export function usableQuestions(questions: unknown): boolean {
  if (!Array.isArray(questions) || questions.length === 0) return false;
  return questions.every((q) => {
    const o = obj(q);
    return !!o && !blank(o.questionNumber) && !blank(o.questionText) &&
      Array.isArray(o.possibleAnswers) && o.possibleAnswers.length > 0 &&
      o.possibleAnswers.every((a) => !!obj(a) && !blank(obj(a)!.value));
  });
}

/** "Transaction Status Completed with Results" — the check was SCORED. It does not mean passed. */
export const IDV_PASS_STATUS = "TSCR";
/**
 * /Idv/getQuestions at MortgageMAX's limit: questions: [] plus responseCode "QuestionsLimitReached"
 * ("Questions may only be retrieved twice per 24 hours"). The limit is GLOBAL per ID number, across
 * all MortgageMAX systems (Louis Pires, 2026-09-30), so a client can reach it before our own count
 * does. Never a transient failure, whatever HTTP status it arrives with.
 */
export const IDV_LIMIT_CODE = "QuestionsLimitReached";
/**
 * Minimum finalScore (0-100) that counts as a pass. Live UAT, 2026-09-29: all five answers right
 * gave TSCR + finalScore "100.00"; deliberately wrong answers ALSO gave TSCR + success:true, with
 * finalScore "20.00". MortgageMAX confirmed (Louis Pires, 2026-09-30) that the API gives no pass or
 * fail — the consuming service decides — and that they usually pass at 60 and above. Production
 * sets MM_IDV_PASS_SCORE=60. The default stays the strictest, so a missing or invalid setting sends
 * people to a second round or manual verification — the safe direction.
 */
export const IDV_PASS_SCORE_DEFAULT = 100;
export function idvPassScore(raw: string | undefined | null): number {
  const n = raw === undefined || raw === null || String(raw).trim() === "" ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 && n <= 100 ? n : IDV_PASS_SCORE_DEFAULT;
}
/** finalScore arrives as a string like "100.00". Blank or unparseable = no score. */
export function idvScore(data: unknown): number | null {
  const v = obj(data)?.finalScore;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string" || v.trim() === "") return null;
  const n = Number(v.trim());
  return Number.isFinite(n) ? n : null;
}

export const succeeded = {
  consentPost: (r: VendorResult) => r.http >= 200 && r.http < 300,
  /** C4: "usable" = a session reference AND every question fully renderable and answerable. */
  getQuestions: (r: VendorResult) => {
    const d = obj(r.data);
    return r.http === 200 && !!d && !blank(d.verificationRequestNumber) && usableQuestions(d.questions);
  },
  /**
   * Passed ONLY when the check was scored (statusCode "TSCR", success not false) AND the score
   * reaches the pass mark. TSCR alone is NOT a pass: wrong answers return it too (see above).
   */
  checkAnswers: (r: VendorResult, passScore: number = IDV_PASS_SCORE_DEFAULT) => {
    const d = obj(r.data);
    const score = idvScore(d);
    return r.http === 200 && !!d && d.statusCode === IDV_PASS_STATUS && d.success !== false &&
      score !== null && score >= passScore;
  },
  creditFull: (r: VendorResult) => {
    const d = obj(r.data);
    return r.http === 200 && !!d && blank(d.errorCode) && !blank(d.groupId) &&
      d.experianCreditCheckData !== null && d.experianCreditCheckData !== undefined;
  },
};

// ---------------------------------------------------------------------------
// Redaction — personId / ID numbers never leave this process in logs
// ---------------------------------------------------------------------------
export function redact(s: string, secrets: Array<string | null | undefined>): string {
  let out = s;
  for (const v of secrets) {
    if (v && v.length >= 4) out = out.split(v).join("[redacted]");
  }
  // Belt and braces: any 13-digit run (SA ID shape).
  return out.replace(/\b\d{13}\b/g, "[redacted-id]");
}

const LOG_BODY_MAX = 2048;

/**
 * What mm_api_log.body_head may keep (C11). Credit-API success bodies are the credit report, the
 * IDV questions (built from the credit file) or the PDF — never persisted, only their size (plus
 * the vendor's error message when a business error came back inside the 200). Errors keep the
 * body for diagnosis, redacted and capped at 2 KB. Consent-API bodies are kept the same way.
 */
export function logBodyHead(api: Api, r: VendorResult, secrets: Array<string | null | undefined>): string {
  const isSuccess = r.http >= 200 && r.http < 300;
  if (api === "credit" && isSuccess) {
    const note = r.vendorCode && r.vendorMessage ? ` ${redact(r.vendorMessage.slice(0, 500), secrets)}` : "";
    return `[omitted: ${r.text.length} chars]${note}`;
  }
  return redact(r.text.slice(0, LOG_BODY_MAX), secrets);
}

// ---------------------------------------------------------------------------
// Optional Entra bearer (D1). Two scope-keyed cached tokens. Inactive unless configured.
// ---------------------------------------------------------------------------
const SCOPES: Record<Api, string> = {
  // Correct spelling. The misspelt "CreditCheckManagment" from the vendor's notes is NOT a registered
  // resource (Entra: AADSTS500011) — verified against the live tenant 2026-09-29.
  credit: "api://CreditCheckManagement/.default",
  consent: "api://ConsentManagement/.default",
};
const tokenCache = new Map<Api, { token: string; expiresAt: number }>();

async function bearer(cfg: MmConfig, api: Api, fetchImpl: typeof fetch): Promise<string | null> {
  if (!cfg.oauth) return null;
  const hit = tokenCache.get(api);
  if (hit && hit.expiresAt > Date.now() + 60_000) return hit.token;
  const res = await fetchImpl(`https://login.microsoftonline.com/${cfg.oauth.tenantId}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: cfg.oauth.clientId,
      client_secret: cfg.oauth.clientSecret,
      scope: SCOPES[api],
    }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) throw new Error(`config_error: token request failed (${res.status})`);
  tokenCache.set(api, { token: j.access_token, expiresAt: Date.now() + (Number(j.expires_in) || 3000) * 1000 });
  return j.access_token;
}

// ---------------------------------------------------------------------------
// The one outbound call
// ---------------------------------------------------------------------------
export interface CallOptions {
  body?: unknown;
  query?: Record<string, string>;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

// Keep whole report and PDF bodies (the credit-reports bucket allows 20 MB of PDF; base64 is ~1.37×).
// Logs never see this — logBodyHead() decides what is persisted.
const MAX_TEXT = 30_000_000;

export async function callVendor(
  cfg: MmConfig,
  api: Api,
  method: "GET" | "POST",
  path: string,
  opts: CallOptions,
): Promise<VendorResult> {
  if (!isAllowed(api, method, path)) throw new Error(`blocked: ${method} ${api}${path} is not allow-listed`);
  const f = opts.fetchImpl ?? fetch;
  const base = api === "credit" ? cfg.creditBaseUrl : cfg.consentBaseUrl;
  const url = new URL(base + path);
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);

  const headers: Record<string, string> = {
    "Ocp-Apim-Subscription-Key": cfg.subscriptionKey,
    "Accept": "application/json",
  };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const token = await bearer(cfg, api, f);
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const started = Date.now();
  const signal = AbortSignal.timeout(opts.timeoutMs);
  // Any failure — before the headers OR while the body is still arriving — is the same outcome:
  // http 0, no data. A throw here would skip the caller's log + state transition (a billed check
  // stuck in check_in_flight).
  const failed = (e: unknown): VendorResult => {
    const timedOut = e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError");
    return {
      http: 0, contentType: "", kind: "empty", data: null, text: String(e).slice(0, 500),
      vendorCode: timedOut ? "timeout" : "network_error", vendorMessage: String(e).slice(0, 500),
      traceId: null, latencyMs: Date.now() - started, timedOut,
    };
  };
  let res: Response;
  try {
    res = await f(url.toString(), {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal,
    });
  } catch (e) {
    return failed(e);
  }
  const contentType = res.headers.get("content-type") ?? "";
  let text: string;
  try {
    // Race the body against the same deadline: a fetch implementation that does not tie the body
    // stream to the signal must still not hang past the timeout.
    text = (await Promise.race([res.text(), abortedBy(signal)])).slice(0, MAX_TEXT);
  } catch (e) {
    res.body?.cancel().catch(() => {});
    return failed(e);
  }
  const { kind, data } = parseBody(text);
  const err = extractVendorError(res.status, kind, data, text);
  return {
    http: res.status, contentType, kind, data, text, ...err,
    latencyMs: Date.now() - started, timedOut: false,
  };
}

function abortedBy(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}
