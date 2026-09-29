import { assertEquals } from "jsr:@std/assert@1";
import { accessFor, ADMIN_ONLY_ACTIONS, isMissingFunction, isMissingTable, type Member, validLinkCode } from "./access.ts";

const ME = "00000000-0000-0000-0000-00000000000b";
const OTHER = "00000000-0000-0000-0000-00000000000c";
const admin: Member = { role: "admin", linkCode: "abc234" };
const consultant: Member = { role: "consultant", linkCode: "def567" };
// Every action mm-staff knows that works on a record.
const RECORD_ACTIONS = ["recover", "clear-config-error", "register-consent", "run-check", "fetch-pdf", "refresh-consents",
  "record-withdrawal", "manual-upload-url", "manual-verify", "reissue-idv-link"];

Deno.test("no active membership: nothing at all", () => {
  for (const a of ["config", ...RECORD_ACTIONS, ...ADMIN_ONLY_ACTIONS]) {
    assertEquals(accessFor(null, a, ME, { consultant_id: ME }), "inactive", a);
  }
});

Deno.test("administrator: everything, on any record", () => {
  for (const a of ["config", ...RECORD_ACTIONS, ...ADMIN_ONLY_ACTIONS]) {
    assertEquals(accessFor(admin, a, ME, { consultant_id: OTHER }), "ok", a);
    assertEquals(accessFor(admin, a, ME, { consultant_id: null }), "ok", a);
  }
});

Deno.test("consultant: own records only; never a colleague's, never an unassigned one", () => {
  for (const a of RECORD_ACTIONS) {
    assertEquals(accessFor(consultant, a, ME, { consultant_id: ME }), "ok", a);
    assertEquals(accessFor(consultant, a, ME, { consultant_id: OTHER }), "not_yours", a);
    assertEquals(accessFor(consultant, a, ME, { consultant_id: null }), "not_yours", a);
    assertEquals(accessFor(consultant, a, ME, {}), "not_yours", a);
    assertEquals(accessFor(consultant, a, ME, null), "not_yours", a);
  }
  assertEquals(accessFor(consultant, "config", ME), "ok");
});

Deno.test("consultant: administrator-only actions are refused even on their own record", () => {
  for (const a of ADMIN_ONLY_ACTIONS) assertEquals(accessFor(consultant, a, ME, { consultant_id: ME }), "admin_only", a);
  assertEquals(ADMIN_ONLY_ACTIONS.includes("delete-record"), true); // deleting destroys audit evidence
});

Deno.test("an unknown action on a record is never allowed through by default", () => {
  assertEquals(accessFor(consultant, "something-new", ME, { consultant_id: OTHER }), "not_yours");
});

Deno.test("missing table / function: exact codes only", () => {
  assertEquals(isMissingTable({ code: "42P01" }), true);
  assertEquals(isMissingTable({ code: "PGRST205" }), true);
  assertEquals(isMissingTable({ code: "42501" }), false); // permission denied is NOT "missing"
  assertEquals(isMissingTable(null), false);
  assertEquals(isMissingFunction({ code: "PGRST202" }), true);
  assertEquals(isMissingFunction({ code: "42883" }), false);
});

Deno.test("link codes: six characters from the issued alphabet", () => {
  assertEquals(validLinkCode("k7m2pq"), true);
  for (const bad of ["K7M2PQ", "k7m2p", "k7m2pqx", "k7m2p0", "k7m2pl", "k7m2p1", "k7m2po", "k7m2pi", "", null, 123456]) {
    assertEquals(validLinkCode(bad), false, String(bad));
  }
});
