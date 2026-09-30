// Unit tests against the REAL vendor bodies captured in UAT (fixtures/*). Run: deno task test
import { assert, assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import {
  callVendor,
  configFromEnv,
  extractVendorError,
  isAllowed,
  logBodyHead,
  type MmConfig,
  parseBody,
  redact,
  succeeded,
  type VendorResult,
  idvPassScore,
} from "./mmax.ts";
import {
  buildCreateConsents,
  buildWithdrawConsents,
  consentGrantState,
  configuredTypeIds,
  type ConsentType,
  contextFor,
  declarationHash,
  normaliseForHash,
  pickTypes,
  renderDeclaration,
  staleAgainst,
} from "./consents.ts";

const fx = (name: string) => Deno.readTextFileSync(new URL(`./fixtures/${name}`, import.meta.url));

const CFG: MmConfig = {
  creditBaseUrl: "https://uat.example/CreditManagement/v1",
  consentBaseUrl: "https://uat.example/ConsentManagement/v3",
  subscriptionKey: "test-key",
  apiClientId: "client-guid",
  env: "test",
};

/** A fetch stub that records the request and replies with a fixture. */
function stub(status: number, body: string, contentType = "application/json") {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const f = (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return Promise.resolve(new Response(body, { status, headers: { "content-type": contentType } }));
  };
  return { f: f as typeof fetch, calls };
}

function result(http: number, text: string): VendorResult {
  const { kind, data } = parseBody(text);
  return { http, contentType: "", kind, data, text, ...extractVendorError(http, kind, data, text), latencyMs: 0, timedOut: false };
}

// --- body sniffing -----------------------------------------------------------
Deno.test("parseBody: JSON object, JSON string, bare text, pdf, base64 pdf, url, empty", () => {
  assertEquals(parseBody('{"a":1}').kind, "json");
  assertEquals(parseBody('"UAT-PROBE-INVALID"'), { kind: "json_string", data: "UAT-PROBE-INVALID" });
  assertEquals(parseBody(fx("consent-201.txt")), { kind: "text", data: "UAT-PROBE-INVALID" });
  assertEquals(parseBody("%PDF-1.7 ...").kind, "pdf_bytes");
  assertEquals(parseBody('"JVBERi0xLjcK"').kind, "pdf_base64");
  assertEquals(parseBody("https://btconsentstorage.blob.core.windows.net/x?sig=1").kind, "url");
  assertEquals(parseBody("  ").kind, "empty");
  assertEquals(parseBody("{not json").kind, "text");
});

// --- the five error vocabularies (real fixtures) ------------------------------
Deno.test("errors: APIM gateway 401 (T1)", () => {
  const r = result(401, fx("gateway-401.json"));
  assertEquals(r.vendorCode, "gateway_401");
  assert(r.vendorMessage?.includes("missing subscription key"));
});

Deno.test("errors: ProblemDetails 400 with field paths + traceId (P1, P10)", () => {
  const p1 = result(400, fx("consent-400-empty.json"));
  assertEquals(p1.vendorCode, "validation");
  assert(p1.vendorMessage?.includes("PersonId: Please specify a Person Id"));
  assert(p1.traceId?.startsWith("00-"));
  const p10 = result(400, fx("consent-400-bad-type.json"));
  assert(p10.vendorMessage?.includes("Consents[0].ConsentTypeId: Consent Type is unknown"));
});

Deno.test("errors: bare text/plain 404 with trailing comma (P3)", () => {
  const r = result(404, fx("credit-full-404.txt"));
  assertEquals(r.vendorCode, "http_404");
  assertEquals(r.vendorMessage, "No Credit Check with Id ''");
});

Deno.test("errors: business error inside HTTP 200, undocumented responseCode (T3)", () => {
  const r = result(200, fx("idv-no-questions.json"));
  assertEquals(r.vendorCode, "NoQuestionsFound");
  assert(r.vendorMessage?.includes("No questions could be returned"));
  assertEquals(succeeded.getQuestions(r), false);
});

Deno.test("errors: CreditCheckResponseDto errorCode inside 200 is a failure", () => {
  const r = result(200, JSON.stringify({ errorCode: "E123", errorString: "Bureau down", groupId: null }));
  assertEquals(r.vendorCode, "E123");
  assertEquals(r.vendorMessage, "Bureau down");
  assertEquals(succeeded.creditFull(r), false);
});

// --- success predicates --------------------------------------------------------
Deno.test("success: consent POST 201 echoes personId (P2) — any 2xx is accepted", () => {
  assert(succeeded.consentPost(result(201, fx("consent-201.txt"))));
  assertEquals(succeeded.consentPost(result(400, fx("consent-400-empty.json"))), false);
});

Deno.test("success: credit full needs no errorCode, a groupId and the report tree", () => {
  const good = result(200, JSON.stringify({ errorCode: null, groupId: "G1", experianCreditCheckData: {} }));
  assert(succeeded.creditFull(good));
  const noGroup = result(200, JSON.stringify({ errorCode: "", groupId: "", experianCreditCheckData: {} }));
  assertEquals(succeeded.creditFull(noGroup), false);
});

Deno.test("success: IDV questions need a request number AND at least one usable question", () => {
  const q = (over: Record<string, unknown> = {}) => ({
    questionNumber: "1", questionText: "Which bank?", possibleAnswers: [{ value: "1", label: "A" }, { value: "2", label: "B" }], ...over,
  });
  const body = (questions: unknown, vrn: unknown = "V1") => result(200, JSON.stringify({ verificationRequestNumber: vrn, questions }));
  assert(succeeded.getQuestions(body([q(), q({ questionNumber: "2" })])));
  // Every field of QuestionData is nullable in the spec — any unusable question fails the round.
  assertEquals(succeeded.getQuestions(body([q(), q({ possibleAnswers: null })])), false);
  assertEquals(succeeded.getQuestions(body([q({ possibleAnswers: [] })])), false);
  assertEquals(succeeded.getQuestions(body([q({ possibleAnswers: [{ value: "1" }, { value: "" }] })])), false);
  assertEquals(succeeded.getQuestions(body([q({ possibleAnswers: [null] })])), false);
  assertEquals(succeeded.getQuestions(body([q({ questionNumber: " " })])), false);
  assertEquals(succeeded.getQuestions(body([q({ questionText: null })])), false);
  assertEquals(succeeded.getQuestions(body([null])), false);
  assertEquals(succeeded.getQuestions(body([])), false);
  assertEquals(succeeded.getQuestions(body([q()], "")), false);
  // Only an HTTP 200 counts.
  assertEquals(succeeded.getQuestions(result(500, JSON.stringify({ verificationRequestNumber: "V1", questions: [q()] }))), false);
  // Real UAT bodies, 2026-09-29. TSCR = "completed with results": BOTH of these carry it.
  const PASS = '{"success":true,"errorCode":null,"responseStatus":"Success","statusCode":"TSCR","statusCodeDescription":"Transaction Status Completed with Results","finalScoreSpecified":true,"finalScore":"100.00"}';
  const WRONG = '{"success":true,"errorCode":null,"responseStatus":"Success","statusCode":"TSCR","statusCodeDescription":"Transaction Status Completed with Results","finalScoreSpecified":true,"finalScore":"20.00"}';
  assert(succeeded.checkAnswers(result(200, PASS)));
  assertEquals(succeeded.checkAnswers(result(200, WRONG)), false);
  // The pass mark is configurable; the default is the strictest.
  const at = (score: string) => result(200, `{"success":true,"statusCode":"TSCR","finalScore":"${score}"}`);
  assertEquals(succeeded.checkAnswers(at("80.00")), false);
  assert(succeeded.checkAnswers(at("80.00"), 80));
  assertEquals(succeeded.checkAnswers(at("60.00"), 80), false);
  // Production mark (vendor practice, 2026-09-30): 60 passes, 59.99 and 40 do not.
  assert(succeeded.checkAnswers(at("60.00"), idvPassScore("60")));
  assertEquals(succeeded.checkAnswers(at("59.99"), idvPassScore("60")), false);
  assertEquals(succeeded.checkAnswers(at("40.00"), idvPassScore("60")), false);
  // No score, no pass — whatever else the body says.
  assertEquals(succeeded.checkAnswers(result(200, '{"success":true,"statusCode":"TSCR"}')), false);
  assertEquals(succeeded.checkAnswers(result(200, '{"success":true,"statusCode":"TSCR","finalScore":""}')), false);
  assertEquals(succeeded.checkAnswers(result(200, '{"success":true,"statusCode":"TSCR","finalScore":"abc"}')), false);
  assertEquals(succeeded.checkAnswers(result(200, '{"success":true,"statusCode":"P","finalScore":"100.00"}')), false);
  assertEquals(succeeded.checkAnswers(result(200, '{"success":false,"statusCode":"TSCR","finalScore":"100.00"}')), false);
  assertEquals(succeeded.checkAnswers(result(500, PASS)), false);
  assertEquals([idvPassScore(undefined), idvPassScore(""), idvPassScore("80"), idvPassScore("0"), idvPassScore("101"), idvPassScore("x")], [100, 100, 80, 100, 100, 100]);
});

// --- allow-list ----------------------------------------------------------------
Deno.test("allow-list: the nine paths only; consent-type writes are blocked", () => {
  assert(isAllowed("consent", "GET", "/ConsentTypes"));
  assert(isAllowed("consent", "POST", "/Consents"));
  assert(isAllowed("credit", "GET", "/CreditCheck/getDocument/G-1/true/true"));
  assertEquals(isAllowed("consent", "POST", "/ConsentTypes"), false);
  assertEquals(isAllowed("credit", "POST", "/CreditCheck/simple"), false);
  assertEquals(isAllowed("credit", "GET", "/CreditCheck/getDocument/G-1/yes/true"), false);
});

// --- callVendor ------------------------------------------------------------------
Deno.test("callVendor: header auth only, never the query key; parses the real P7 read-back", async () => {
  const { f, calls } = stub(200, fx("consents-readback.json"));
  const r = await callVendor(CFG, "consent", "GET", "/Consents", {
    query: { PersonId: "P-1" },
    timeoutMs: 1000,
    fetchImpl: f,
  });
  assertEquals(r.http, 200);
  assertEquals(r.kind, "json");
  assert(Array.isArray(r.data));
  const h = calls[0].init.headers as Record<string, string>;
  assertEquals(h["Ocp-Apim-Subscription-Key"], "test-key");
  assertEquals(h["Authorization"], undefined);
  assertEquals(new URL(calls[0].url).searchParams.get("subscription-key"), null);
});

Deno.test("callVendor: mock mode works with the Entra bearer configured (live, 2026-09-30)", async () => {
  // Every vendor step failed in mock mode once MMAX_OAUTH_* were loaded: the token request went to
  // mockFetch, which parsed its form-encoded body as JSON and threw.
  const { mockFetch } = await import("./mock.ts");
  const cfg: MmConfig = { ...CFG, oauth: { tenantId: "t", clientId: "c", clientSecret: "s" } };
  const r = await callVendor(cfg, "credit", "POST", "/Idv/getQuestions", {
    body: { idNumber: "0000000000000", idType: "SID" }, timeoutMs: 1000, fetchImpl: mockFetch,
  });
  assertEquals(r.http, 200);
  assert(succeeded.getQuestions(r));
});

Deno.test("callVendor: refuses anything not allow-listed", async () => {
  const { f } = stub(200, "{}");
  await assertRejects(
    () => callVendor(CFG, "consent", "POST", "/ConsentTypes", { body: {}, timeoutMs: 1000, fetchImpl: f }),
    Error,
    "not allow-listed",
  );
});

Deno.test("callVendor: timeout becomes http 0 + vendorCode timeout", async () => {
  const hang = ((_u: unknown, init?: RequestInit) =>
    new Promise((_, rej) =>
      init?.signal?.addEventListener("abort", () => rej(new DOMException("t", "TimeoutError")))
    )) as typeof fetch;
  const r = await callVendor(CFG, "credit", "POST", "/CreditCheck/full", { body: {}, timeoutMs: 20, fetchImpl: hang });
  assertEquals(r.http, 0);
  assertEquals(r.vendorCode, "timeout");
  assert(r.timedOut);
});

Deno.test("callVendor: a body that stalls after the headers still resolves as a timeout (http 0)", async () => {
  // Headers arrive at once; the body sends one chunk then never finishes. The stub does not tie
  // the stream to the abort signal, so callVendor itself must enforce the deadline.
  const stall = (() => {
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('{"groupId":"G1","experianCreditCheckData":{'));
      },
    });
    return Promise.resolve(new Response(stream, { status: 200, headers: { "content-type": "application/json" } }));
  }) as typeof fetch;
  const r = await callVendor(CFG, "credit", "POST", "/CreditCheck/full", { body: {}, timeoutMs: 30, fetchImpl: stall });
  assertEquals(r.http, 0);
  assertEquals(r.vendorCode, "timeout");
  assert(r.timedOut);
  assertEquals(r.data, null);
  assertEquals(succeeded.creditFull(r), false);
});

Deno.test("callVendor: a body that errors mid-stream resolves as network_error (http 0), never throws", async () => {
  const broken = (() => {
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('{"partial":'));
        c.error(new TypeError("connection reset"));
      },
    });
    return Promise.resolve(new Response(stream, { status: 201 }));
  }) as typeof fetch;
  const r = await callVendor(CFG, "consent", "POST", "/Consents", { body: {}, timeoutMs: 1000, fetchImpl: broken });
  assertEquals(r.http, 0);
  assertEquals(r.vendorCode, "network_error");
  assertEquals(r.timedOut, false);
  assertEquals(succeeded.consentPost(r), false);
});

Deno.test("callVendor: bodies over 2 MB are kept whole (large reports / PDFs parse)", async () => {
  const big = JSON.stringify({ groupId: "G1", errorCode: null, experianCreditCheckData: { pad: "x".repeat(3_000_000) } });
  const { f } = stub(200, big);
  const r = await callVendor(CFG, "credit", "POST", "/CreditCheck/full", { body: {}, timeoutMs: 5000, fetchImpl: f });
  assertEquals(r.kind, "json");
  assert(succeeded.creditFull(r));
});

// --- logging (C11) -------------------------------------------------------------------
Deno.test("logBodyHead: credit success bodies are never persisted — only their size", () => {
  const report = result(200, JSON.stringify({ groupId: "G1", experianCreditCheckData: { cC_RESULTS: { name: "SECRET" } } }));
  const head = logBodyHead("credit", report, []);
  assertEquals(head, `[omitted: ${report.text.length} chars]`);
  const questions = result(200, JSON.stringify({ verificationRequestNumber: "VRN-SECRET", questions: [{ questionText: "Which bank?" }] }));
  assertEquals(logBodyHead("credit", questions, []).includes("VRN-SECRET"), false);
  // A business error inside the 200 keeps only the vendor's message, not the body.
  const t3 = result(200, fx("idv-no-questions.json"));
  const t3Head = logBodyHead("credit", t3, []);
  assert(t3Head.startsWith("[omitted: "));
  assert(t3Head.includes("No questions could be returned"));
});

Deno.test("logBodyHead: errors keep the body, redacted and capped at 2 KB; consent bodies are kept", () => {
  const p3 = result(404, fx("credit-full-404.txt"));
  assertEquals(logBodyHead("credit", p3, []), fx("credit-full-404.txt"));
  const long = result(500, `oops 8001015009087 P-XYZ ${"y".repeat(5000)}`);
  const head = logBodyHead("credit", long, ["P-XYZ"]);
  assert(head.length <= 2048 + 40);
  assertEquals(head.includes("8001015009087"), false);
  assertEquals(head.includes("P-XYZ"), false);
  const timeout: VendorResult = { ...result(0, ""), text: "TimeoutError: signal timed out", vendorCode: "timeout", timedOut: true };
  assertEquals(logBodyHead("credit", timeout, []), "TimeoutError: signal timed out");
  const readback = result(200, fx("consents-readback.json"));
  const rb = logBodyHead("consent", readback, []);
  assert(rb.startsWith('[{"id"'));
  assert(rb.length <= 2048);
});

// --- config + redaction ------------------------------------------------------------
Deno.test("configFromEnv: missing secret is a config_error; bearer off unless both set", () => {
  assertThrows(() => configFromEnv(() => undefined), Error, "config_error");
  const env: Record<string, string> = {
    MMAX_CREDIT_BASE_URL: "https://x/CreditManagement/v1/",
    MMAX_CONSENT_BASE_URL: "https://x/ConsentManagement/v3",
    MMAX_SUBSCRIPTION_KEY: "k",
    MMAX_API_CLIENT_ID: "c",
  };
  const cfg = configFromEnv((k) => env[k]);
  assertEquals(cfg.creditBaseUrl, "https://x/CreditManagement/v1");
  assertEquals(cfg.oauth, undefined);
});

Deno.test("redact: removes the personId and any 13-digit SA ID shape", () => {
  const out = redact('{"personId":"8001015009087","x":"P-ABC123"}', ["P-ABC123"]);
  assertEquals(out.includes("8001015009087"), false);
  assertEquals(out.includes("P-ABC123"), false);
});

// --- consents (real active MortgageMax types) -----------------------------------------
const LIVE: ConsentType[] = JSON.parse(
  Deno.readTextFileSync(new URL("../../../assets/fixtures/consent-types.json", import.meta.url)),
);
const BROAD = "818BB417-0963-4DFF-B7E3-09C66F6D0AF9";

Deno.test("consents: configured id picks Broad consent MM (case-insensitive); inactive/missing fail loudly", () => {
  const [t] = pickTypes(LIVE, configuredTypeIds(JSON.stringify([BROAD.toLowerCase()])));
  assertEquals(t.name, "Broad consent MM");
  assertThrows(() => pickTypes(LIVE, ["00000000-0000-4000-8000-000000000000"]), Error, "config_error");
  assertThrows(() => pickTypes([{ ...t, active: false }], [BROAD]), Error, "inactive");
  assertThrows(() => configuredTypeIds("[]"), Error, "config_error");
});

Deno.test("consents: ${MOBusinessGroup} → MortgageMAX; context filled from contextDefinition", () => {
  assertEquals(renderDeclaration("appoint ${MOBusinessGroup} as agent"), "appoint MortgageMAX as agent");
  const t: ConsentType = {
    id: "x", name: "n", version: "1", active: true, declaration: "d",
    contextDefinition: { MOBusinessGroup: "${MOBusinessGroup}" },
  };
  assertEquals(contextFor(t), { MOBusinessGroup: "MortgageMAX" });
  assertThrows(() => contextFor({ ...t, contextDefinition: { Other: "${Other}" } }), Error, "config_error");
});

Deno.test("consents: hash ignores CRLF vs LF; stale detection catches a version bump", async () => {
  assertEquals(normaliseForHash("a\r\nb\r\n"), "a\nb");
  const [t] = pickTypes(LIVE, [BROAD]);
  const presented = [{ id: t.id, version: t.version, hash: await declarationHash(t) }];
  assertEquals(await staleAgainst(presented, [t]), []);
  assertEquals(await staleAgainst(presented, [{ ...t, version: "14" }]), [t.id]);
});

Deno.test("consents: CreateConsentsRequest shape matches the spec's required fields", () => {
  const [t] = pickTypes(LIVE, [BROAD]);
  const body = buildCreateConsents({
    personId: "P", apiClientId: "C", ref: "PM-ABC123", types: [t], granted: true, createdBy: "promortgagesa-web",
  });
  assertEquals(body.personId, "P");
  const c = body.consents[0];
  for (const k of ["apiClientId", "consentTypeId", "createdBy", "granted"]) assert(k in c, `missing ${k}`);
  assertEquals(c.sourceURN, "urn:promortgagesa:credit-check:PM-ABC123");
  assertThrows(() => buildCreateConsents({ ...{ apiClientId: "C", ref: "r", types: [t], granted: true, createdBy: "x" }, personId: "" }));
});

Deno.test("consents: grant state — all configured types granted vs a refusal on record (case-insensitive)", () => {
  const rec = (consentTypeId: string, granted: boolean) => ({ consentTypeId, granted });
  assertEquals(consentGrantState([rec(BROAD.toLowerCase(), true)], [BROAD]), { allGranted: true, anyRefused: false });
  assertEquals(consentGrantState([rec(BROAD, false)], [BROAD]), { allGranted: false, anyRefused: true });
  assertEquals(consentGrantState([], [BROAD]), { allGranted: false, anyRefused: false });
  // Another licensee's / another type's record does not count either way.
  assertEquals(consentGrantState([rec("762fc8a5-5320-4b9d-f6f2-08d9365cbe7e", false)], [BROAD]), { allGranted: false, anyRefused: false });
  // Two configured types: one missing → not all granted.
  assertEquals(consentGrantState([rec(BROAD, true)], [BROAD, "5911C3C5-EBA7-4340-82D3-5771F0CF4427"]).allGranted, false);
  assertEquals(consentGrantState(null, [BROAD]), { allGranted: false, anyRefused: false });
  // The real P7 read-back holds a granted=false record for 762fc8a5.
  const p7 = JSON.parse(fx("consents-readback.json"));
  assertEquals(consentGrantState(p7, ["762FC8A5-5320-4B9D-F6F2-08D9365CBE7E"]).anyRefused, true);
});

Deno.test("consents: withdrawal body replays the registered types with granted=false", () => {
  const body = buildWithdrawConsents({
    personId: "P", apiClientId: "C", ref: "PM-1", createdBy: "staff@x", items: [{ id: BROAD, context: { MOBusinessGroup: "MortgageMAX" } }],
  });
  assertEquals(body.consents.length, 1);
  assertEquals(body.consents[0].granted, false);
  assertEquals(body.consents[0].consentTypeId, BROAD);
  assertEquals(body.consents[0].context, { MOBusinessGroup: "MortgageMAX" });
  assertThrows(() => buildWithdrawConsents({ personId: "P", apiClientId: "C", ref: "r", createdBy: "x", items: [] }));
  assertThrows(() => buildWithdrawConsents({ personId: "", apiClientId: "C", ref: "r", createdBy: "x", items: [{ id: BROAD, context: {} }] }));
});
