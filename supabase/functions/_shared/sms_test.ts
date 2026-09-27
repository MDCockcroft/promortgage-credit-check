// SMS gateway tests. Response shapes follow the SMSPortal v3 OpenAPI (SendRequest / Response).
// Run: deno task test
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import { gsm7Length, interpretSend, otpMessage, sendSms, type SmsConfig, smsConfigFromEnv, smsGuard } from "./sms.ts";

const env = (m: Record<string, string>) => (k: string) => m[k];
const LIVE: SmsConfig = {
  mode: "live", clientId: "cid", apiSecret: "shh", brand: "Pro Mortgages SA",
  baseUrl: "https://rest.example", dailyMax: 300,
};
const OK_BODY = JSON.stringify({
  statusCode: 200, errors: [],
  sendResponse: {
    cost: 1, remainingBalance: 499, eventId: 123456789, sample: "x", costBreakdown: [], messages: 1, parts: 1,
    errorReport: { noNetwork: 0, noContents: 0, contentToLong: 0, duplicates: 0, optedOuts: 0, faults: [] },
  },
});

function stub(status: number, body: string) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const f = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(new Response(body, { status, headers: { "content-type": "application/json" } }));
  }) as unknown as typeof fetch;
  return { f, calls };
}

Deno.test("config: mock is the default and needs no credentials", () => {
  const c = smsConfigFromEnv(env({}));
  assertEquals(c.mode, "mock");
  assertEquals(c.brand, "Pro Mortgages SA");
  assertEquals(c.dailyMax, 300);
});

Deno.test("config: test and live refuse to start without credentials", () => {
  assertThrows(() => smsConfigFromEnv(env({ SMS_MODE: "live" })), Error, "config_error");
  assertThrows(() => smsConfigFromEnv(env({ SMS_MODE: "test", SMSPORTAL_CLIENT_ID: "a" })), Error, "config_error");
  assertThrows(() => smsConfigFromEnv(env({ SMS_MODE: "loud" })), Error, "config_error");
  assertThrows(() => smsConfigFromEnv(env({ SMS_SENDER_ID: "ProMortgagesSA" })), Error, "11 characters");
  const c = smsConfigFromEnv(env({ SMS_MODE: " LIVE ", SMSPORTAL_CLIENT_ID: "a", SMSPORTAL_API_SECRET: "b", SMS_DAILY_MAX: "abc" }));
  assertEquals(c.mode, "live");
  assertEquals(c.dailyMax, 300);
});

Deno.test("guard: production MortgageMAX refuses any SMS mode but live", () => {
  const mock = smsConfigFromEnv(env({}));
  assertEquals(smsGuard(mock, "uat"), null);
  assert(smsGuard(mock, "prod"));
  assert(smsGuard(mock, "production"));
  assertEquals(smsGuard(LIVE, "prod"), null);
});

Deno.test("message: one GSM-7 segment for the brand names in play", () => {
  for (const brand of ["Pro Mortgages SA", "Pro Mortgage SA", "ProMortgage"]) {
    const n = gsm7Length(otpMessage(brand, "048213"));
    assert(n !== null, `${brand}: not GSM-7`);
    assert(n <= 160, `${brand}: ${n} chars`);
  }
  assertEquals(gsm7Length("it’s"), null); // curly apostrophe → UCS-2
  assertEquals(gsm7Length("€"), 2);
});

Deno.test("send: live posts one message with basic auth and no test flag", async () => {
  const { f, calls } = stub(200, OK_BODY);
  const r = await sendSms(LIVE, { to: "27821234567", text: "hi", customerId: "PM-ABC123" }, { fetchImpl: f });
  assertEquals(r.ok, true);
  assertEquals(r.status, "sent");
  assertEquals(r.eventId, "123456789");
  assertEquals(calls.length, 1);
  assertEquals(calls[0].url, "https://rest.example/v3/BulkMessages");
  const h = calls[0].init.headers as Record<string, string>;
  assertEquals(h.Authorization, `Basic ${btoa("cid:shh")}`);
  const b = JSON.parse(String(calls[0].init.body));
  assertEquals(b.sendOptions.testMode, false);
  assertEquals(b.messages, [{ destination: "27821234567", content: "hi", customerId: "PM-ABC123" }]);
});

Deno.test("send: test mode sets testMode:true; mock makes no call", async () => {
  const { f, calls } = stub(200, OK_BODY);
  await sendSms({ ...LIVE, mode: "test" }, { to: "27821234567", text: "hi", customerId: "r" }, { fetchImpl: f });
  assertEquals(JSON.parse(String(calls[0].init.body)).sendOptions.testMode, true);
  const m = await sendSms({ ...LIVE, mode: "mock" }, { to: "27821234567", text: "hi", customerId: "r" }, { fetchImpl: f });
  assertEquals(m.ok, true);
  assertEquals(calls.length, 1);
});

Deno.test("interpret: 401 bare auth error", () => {
  const r = interpretSend(401, JSON.stringify({ errorCode: "Authentication.InvalidCredentials", errorMessage: "no" }));
  assertEquals(r.ok, false);
  assertEquals(r.status, "failed");
  assertEquals(r.errorCode, "Authentication.InvalidCredentials");
});

Deno.test("interpret: 200 with a send-wide error is a failure", () => {
  const r = interpretSend(200, JSON.stringify({ statusCode: 400, errors: [{ errorCode: "InsufficientCredits", errorMessage: "x" }] }));
  assertEquals(r.ok, false);
  assertEquals(r.errorCode, "InsufficientCredits");
});

Deno.test("interpret: 200 with a per-message fault or opt-out is a failure", () => {
  const faulted = JSON.parse(OK_BODY);
  faulted.sendResponse.errorReport.faults = [{ rawDestination: "x", scrubbedDestination: "x", customerId: "r", errorMessage: "Invalid number", status: "InvalidDestination" }];
  assertEquals(interpretSend(200, JSON.stringify(faulted)).errorCode, "InvalidDestination");
  const optedOut = JSON.parse(OK_BODY);
  optedOut.sendResponse.errorReport.optedOuts = 1;
  assertEquals(interpretSend(200, JSON.stringify(optedOut)).errorCode, "optedOuts");
});

Deno.test("interpret: 200 without a sendResponse is not taken as sent", () => {
  assertEquals(interpretSend(200, "OK").ok, false);
  assertEquals(interpretSend(200, "{}").errorCode, "unexpected_body");
  assertEquals(interpretSend(503, "").errorCode, "http_503");
});

Deno.test("send: a timeout is 'unknown' (it may still arrive), a network error is 'failed'", async () => {
  const hang = ((_u: string, init: RequestInit) =>
    new Promise((_res, rej) => init.signal!.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))))
  ) as unknown as typeof fetch;
  const t = await sendSms(LIVE, { to: "27821234567", text: "hi", customerId: "r" }, { fetchImpl: hang, timeoutMs: 20 });
  assertEquals([t.status, t.errorCode], ["unknown", "timeout"]);
  const boom = (() => Promise.reject(new TypeError("dns"))) as unknown as typeof fetch;
  const n = await sendSms(LIVE, { to: "27821234567", text: "hi", customerId: "r" }, { fetchImpl: boom });
  assertEquals([n.status, n.errorCode], ["failed", "network"]);
});
