import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { buildCreatePerson, peopleRefs, personIdFrom, plausiblePersonId, resolvePersonId } from "./people.ts";
import type { MmConfig, VendorResult } from "./mmax.ts";

const refs = { sourceSystemTypeId: 7, identityDocumentTypeId: 1, countryOfOriginId: "ZA", phoneNumberTypeId: 2, emailAddressTypeId: 1 };
const row = { first_names: " Bongani ", surname: "Stoffel", cell: "0820000001", email: "b@example.com" };
const ID = "7805230055084";
const vr = (http: number, data: unknown, kind = "json"): VendorResult => ({
  http, contentType: "application/json", kind: kind as VendorResult["kind"], data, text: typeof data === "string" ? data : JSON.stringify(data),
  vendorCode: null, vendorMessage: null, traceId: null, latencyMs: 1, timedOut: false,
});
function cfg(people: MmConfig["people"] = refs): MmConfig {
  return { creditBaseUrl: "https://x/credit", consentBaseUrl: "https://x/consent", peopleBaseUrl: "https://x/PeopleManagement/v2",
    subscriptionKey: "k", apiClientId: "c", env: "uat", people, peopleScope: "api://People/.default" };
}
type Step = { m: string; path: RegExp; status: number; body: unknown; text?: boolean; bodyCheck?: (b: unknown) => void };
function fakeFetch(script: Step[]) {
  const calls: string[] = [];
  const f = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input)); const m = (init?.method ?? "GET").toUpperCase();
    calls.push(`${m} ${url.pathname}`);
    const i = script.findIndex((s) => s.m === m && s.path.test(url.pathname + url.search));
    if (i < 0) return Promise.resolve(new Response("no route", { status: 599 }));
    const hit = script.splice(i, 1)[0];
    if (hit.bodyCheck) hit.bodyCheck(init?.body ? JSON.parse(String(init.body)) : null);
    return Promise.resolve(new Response(hit.text ? String(hit.body) : JSON.stringify(hit.body), {
      status: hit.status, headers: { "Content-Type": hit.text ? "text/plain" : "application/json" } }));
  }) as typeof fetch;
  return { f, calls };
}
const ctx = (f: typeof fetch, c = cfg()) => ({ cfg: c, fetchImpl: f, log: async () => {} });
const FIND = /\/People\/IdentityNumber\?IdentityNumber=7805230055084&IdentityDocumentTypeId=1$/;
const CREATE = /\/People$/;

Deno.test("peopleRefs: a base URL without the three reference ids is a config error on the People path", () => {
  assertThrows(() => peopleRefs(cfg({ sourceSystemTypeId: 7 })), Error, "config_error: People domain incomplete");
  assertThrows(() => peopleRefs({ ...cfg(), peopleBaseUrl: undefined }), Error, "MMAX_PEOPLE_BASE_URL");
  assertEquals(peopleRefs(cfg()).countryOfOriginId, "ZA");
});

Deno.test("buildCreatePerson: name, ID document and primary contacts; contacts can be left out", () => {
  assertEquals(buildCreatePerson(row, ID, refs), {
    name: { givenName: "Bongani", familyName: "Stoffel" }, sourceSystemTypeId: 7,
    identityDocument: { identityDocumentTypeId: 1, identityNumber: ID, countryOfOriginId: "ZA", isVerified: false },
    phoneNumbers: [{ value: "0820000001", isPrimary: true, phoneNumberTypeId: 2 }],
    emailAddresses: [{ value: "b@example.com", isPrimary: true, emailAddressTypeId: 1 }],
  });
  const bare = buildCreatePerson(row, ID, refs, { contacts: false });
  assertEquals("phoneNumbers" in bare || "emailAddresses" in bare, false);
});

Deno.test("plausiblePersonId / personIdFrom: a GUID or a real id, never a word, never a bare string on a find", () => {
  assertEquals(plausiblePersonId("2F0C9F8E-1A2B-4C3D-9E8F-0A1B2C3D4E5F"), "2F0C9F8E-1A2B-4C3D-9E8F-0A1B2C3D4E5F");
  assertEquals(plausiblePersonId("P-20261020-0042"), "P-20261020-0042");
  assertEquals(plausiblePersonId(12345), "12345");
  for (const bad of ["null", "true", "false", "Created", "NotFound", "undefined", "None", "Success", "string", "", "   ", "00000000-0000-0000-0000-000000000000", "Person not found"]) {
    assertEquals(plausiblePersonId(bad), null, bad);
  }
  assertEquals(personIdFrom(vr(200, { id: "2f0c9f8e-1a2b-4c3d-9e8f-0a1b2c3d4e5f" }), "find"), "2f0c9f8e-1a2b-4c3d-9e8f-0a1b2c3d4e5f");
  assertEquals(personIdFrom(vr(200, "2f0c9f8e-1a2b-4c3d-9e8f-0a1b2c3d4e5f", "json_string"), "find"), null); // a find answers an object
  assertEquals(personIdFrom(vr(201, "\"2f0c9f8e-1a2b-4c3d-9e8f-0a1b2c3d4e5f\"", "text"), "create"), "2f0c9f8e-1a2b-4c3d-9e8f-0a1b2c3d4e5f");
  assertEquals(personIdFrom(vr(201, "Created", "text"), "create"), null);
  assertEquals(personIdFrom(vr(200, { id: null }), "find"), null);
});

Deno.test("resolvePersonId: known ID number → found, nothing created; the person's own ID number must match", async () => {
  const a = fakeFetch([{ m: "GET", path: FIND, status: 200, body: { id: "P-known-01", identityDocument: { identityNumber: ID } } }]);
  assertEquals(await resolvePersonId(ctx(a.f), row, ID), { ok: true, personId: "P-known-01", created: false });
  assertEquals(a.calls, ["GET /PeopleManagement/v2/People/IdentityNumber"]);
  const b = fakeFetch([{ m: "GET", path: FIND, status: 200, body: { id: "P-other-02", identityDocument: { identityNumber: "9204015192080" } } }]);
  const r = await resolvePersonId(ctx(b.f), row, ID);
  assertEquals(r.ok, false); if (!r.ok) assertEquals(r.code === "manual" && r.reason, "person_mismatch");
});

Deno.test("resolvePersonId: unknown → created with contacts; a 400 retries once without them; a second 400 goes to a person", async () => {
  const a = fakeFetch([
    { m: "GET", path: FIND, status: 404, body: "Person not found", text: true },
    { m: "POST", path: CREATE, status: 201, body: "P-new-0001", text: true, bodyCheck: (b) => assertEquals(Array.isArray((b as Record<string, unknown>).phoneNumbers), true) },
  ]);
  assertEquals(await resolvePersonId(ctx(a.f), row, ID), { ok: true, personId: "P-new-0001", created: true });
  const b = fakeFetch([
    { m: "GET", path: FIND, status: 404, body: "x", text: true },
    { m: "POST", path: CREATE, status: 400, body: { title: "phone invalid" } },
    { m: "POST", path: CREATE, status: 201, body: "P-new-0002", text: true, bodyCheck: (bd) => assertEquals("phoneNumbers" in (bd as Record<string, unknown>), false) },
  ]);
  assertEquals(await resolvePersonId(ctx(b.f), row, ID), { ok: true, personId: "P-new-0002", created: true });
  assertEquals(b.calls.length, 3);
  const c = fakeFetch([
    { m: "GET", path: FIND, status: 404, body: "x", text: true },
    { m: "POST", path: CREATE, status: 400, body: { title: "bad" } }, { m: "POST", path: CREATE, status: 400, body: { title: "bad" } },
  ]);
  const r = await resolvePersonId(ctx(c.f), row, ID);
  assertEquals(r.ok, false); if (!r.ok) assertEquals(r.code === "manual" && r.reason, "person_rejected");
});

Deno.test("resolvePersonId: 409s — a conflicting create re-reads once; a conflicting lookup goes to a person", async () => {
  const a = fakeFetch([
    { m: "GET", path: FIND, status: 404, body: "x", text: true },
    { m: "POST", path: CREATE, status: 409, body: "exists", text: true },
    { m: "GET", path: FIND, status: 200, body: { id: "P-raced-03", identityDocument: { identityNumber: ID } } },
  ]);
  assertEquals(await resolvePersonId(ctx(a.f), row, ID), { ok: true, personId: "P-raced-03", created: false });
  const b = fakeFetch([{ m: "GET", path: FIND, status: 409, body: "duplicate", text: true }]);
  const r = await resolvePersonId(ctx(b.f), row, ID);
  assertEquals(r.ok, false); if (!r.ok) assertEquals(r.code === "manual" && r.reason, "duplicate_person");
  assertEquals(b.calls.length, 1);
});

Deno.test("resolvePersonId: 401 is our configuration, a 500 is the vendor's; neither creates anything", async () => {
  const r1 = await resolvePersonId(ctx(fakeFetch([{ m: "GET", path: FIND, status: 401, body: "", text: true }]).f), row, ID);
  assertEquals(r1.ok, false); if (!r1.ok) assertEquals(r1.code, "config_error");
  const b = fakeFetch([{ m: "GET", path: FIND, status: 500, body: { error: "x" } }]);
  const r2 = await resolvePersonId(ctx(b.f), row, ID);
  assertEquals(r2.ok, false); if (!r2.ok) assertEquals(r2.code, "vendor_error");
  assertEquals(b.calls.length, 1);
});

Deno.test("configFromEnv: a half-set or odd People configuration never throws; whitespace is unset; bad ids read as absent", async () => {
  const { configFromEnv } = await import("./mmax.ts");
  const base = { MMAX_CREDIT_BASE_URL: "https://x/c", MMAX_CONSENT_BASE_URL: "https://x/s", MMAX_SUBSCRIPTION_KEY: "k", MMAX_API_CLIENT_ID: "c" };
  const get = (env: Record<string, string>) => (k: string) => env[k];
  assertEquals(configFromEnv(get({ ...base, MMAX_PEOPLE_BASE_URL: "   " })).peopleBaseUrl, undefined);
  const half = configFromEnv(get({ ...base, MMAX_PEOPLE_BASE_URL: "https://x/PeopleManagement/v2/", MMAX_PEOPLE_SOURCE_SYSTEM_ID: "0x10", MMAX_PEOPLE_ID_DOC_TYPE_ID: " 3 " }));
  assertEquals(half.peopleBaseUrl, "https://x/PeopleManagement/v2");
  assertEquals(half.people?.sourceSystemTypeId, undefined);
  assertEquals(half.people?.identityDocumentTypeId, 3);
  assertEquals(half.peopleScope, "api://People/.default");
  assertThrows(() => peopleRefs(half), Error, "MMAX_PEOPLE_SOURCE_SYSTEM_ID");
});
