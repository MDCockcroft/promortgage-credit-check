import { assertEquals } from "jsr:@std/assert@1";
import {
  ATTESTATION, CONSENT_FORM, consentFormPath, idDocPath, manualVerifyCheck, sha256HexBytes, sniffDocType,
  validConsentFormPath, validIdDocPath,
} from "./manual.ts";

const said = (extra: Record<string, unknown>) => ({ id_type: "said", consent_registered_at: "2026-09-28T10:00:00Z", ...extra });

Deno.test("attestation: verbatim MortgageMAX wording, versioned", () => {
  assertEquals(ATTESTATION.version, "experian-manual-2026-09-28");
  assertEquals(ATTESTATION.text.startsWith("I hereby confirm that I have read and understood the Experian Terms and conditions"), true);
  assertEquals(ATTESTATION.text.endsWith("before requesting their credit information via the Experian System."), true);
  assertEquals(ATTESTATION.text.includes("  "), false); // the concatenation left no double spaces
});

Deno.test("manualVerifyCheck: only where consent is registered and nothing is running", () => {
  for (const st of ["consent_registered", "idv_failed", "idv_unavailable", "idv_waived"]) {
    assertEquals(manualVerifyCheck(said({ status: st })).ok, true, st);
  }
  // The identity-round limit keeps consent_registered_at → allowed; consent-side exits clear it → refused.
  assertEquals(manualVerifyCheck(said({ status: "manual_required" })).ok, true);
  assertEquals(manualVerifyCheck(said({ status: "manual_required", consent_registered_at: null })).ok, false);
  for (const st of ["awaiting_otp", "consent_confirmed", "idv_in_progress", "idv_passed", "manual_verified",
    "check_in_flight", "report_ready", "check_failed", "consent_withdrawn", "expired", "config_error"]) {
    assertEquals(manualVerifyCheck(said({ status: st })).ok, false, st);
  }
  // Never for passports (no credit check for foreign nationals), never after a withdrawal.
  assertEquals(manualVerifyCheck({ id_type: "passport", status: "consent_registered", consent_registered_at: "x" }),
    { ok: false, reason: "not_sa_id" });
  assertEquals(manualVerifyCheck(said({ status: "idv_failed", consent_withdrawn_at: "x" })), { ok: false, reason: "withdrawn" });
});

Deno.test("ID copy paths: server-chosen, bound to the ref, accepted types only", () => {
  const p = idDocPath("PM-ABC123", "image/png")!;
  assertEquals(validIdDocPath("PM-ABC123", p), true);
  assertEquals(validIdDocPath("PM-OTHER1", p), false);
  assertEquals(idDocPath("PM-ABC123", "image/gif"), null);
  assertEquals(validIdDocPath("PM-ABC123", "PM-ABC123/../PM-X/a.pdf"), false);
  assertEquals(validIdDocPath("PM-ABC123", "PM-ABC123/not-a-uuid.pdf"), false);
  assertEquals(validIdDocPath("PM-ABC123", 42), false);
});

Deno.test("signed consent form: its own path, never interchangeable with the ID copy", () => {
  // MortgageMAX, 2026-10-01: the manual route needs the client's signed Consent Form as well.
  assertEquals(CONSENT_FORM.version, "mmax-consent-form-2025-11");
  const form = consentFormPath("PM-ABC123", "application/pdf")!;
  const id = idDocPath("PM-ABC123", "application/pdf")!;
  assertEquals(validConsentFormPath("PM-ABC123", form), true);
  assertEquals(validConsentFormPath("PM-OTHER1", form), false);
  // An upload made as one kind cannot be passed off as the other.
  assertEquals(validConsentFormPath("PM-ABC123", id), false);
  assertEquals(validIdDocPath("PM-ABC123", form), false);
  assertEquals(consentFormPath("PM-ABC123", "image/gif"), null);
  assertEquals(validConsentFormPath("PM-ABC123", "PM-ABC123/consent-not-a-uuid.pdf"), false);
  assertEquals(validConsentFormPath("PM-ABC123", "PM-ABC123/../PM-X/consent-a.pdf"), false);
  assertEquals(validConsentFormPath("PM-ABC123", null), false);
});

Deno.test("sniffDocType: magic bytes, not the declared type", async () => {
  const b = (...x: number[]) => new Uint8Array(x);
  assertEquals(sniffDocType(new TextEncoder().encode("%PDF-1.7\n")), "application/pdf");
  assertEquals(sniffDocType(b(0xff, 0xd8, 0xff, 0xe0)), "image/jpeg");
  assertEquals(sniffDocType(b(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)), "image/png");
  assertEquals(sniffDocType(new TextEncoder().encode("<html>")), null);
  assertEquals(sniffDocType(b()), null);
  assertEquals(await sha256HexBytes(new Uint8Array()), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
});
