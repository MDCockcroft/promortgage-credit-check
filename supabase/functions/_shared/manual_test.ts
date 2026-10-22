import { assertEquals } from "jsr:@std/assert@1";
import {
  ATTESTATION, CLIENT_ID_COPY_FROM, clientIdCopyCheck, CONSENT_FORM, consentFormPath, idBackPath, idCopyPath,
  IDENTITY_CONFIRMATION, manualVerifyCheck, sha256HexBytes, sniffDocType, validConsentFormPath, validIdBackPath,
  validIdCopyPath,
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
  for (const st of ["consent_confirmed", "idv_in_progress", "idv_passed", "manual_verified",
    "check_in_flight", "report_ready", "check_failed", "consent_withdrawn", "expired", "config_error"]) {
    assertEquals(manualVerifyCheck(said({ status: st })).ok, false, st);
  }
  // Never for passports (no credit check for foreign nationals), never after a withdrawal.
  assertEquals(manualVerifyCheck({ id_type: "passport", status: "consent_registered", consent_registered_at: "x" }),
    { ok: false, reason: "not_sa_id" });
  assertEquals(manualVerifyCheck(said({ status: "idv_failed", consent_withdrawn_at: "x" })), { ok: false, reason: "withdrawn" });
});

Deno.test("the client's ID copy: server-chosen path on the record, bound to the ref, never a form's or an old photo's", () => {
  // Michael, 2026-10-20: the ID copy is attached to every record; no credit check without it.
  assertEquals(IDENTITY_CONFIRMATION.version, "idv-confirm-2026-10-20");
  assertEquals(IDENTITY_CONFIRMATION.text.includes("  "), false);
  const p = idCopyPath("PM-ABC123", "application/pdf")!;
  assertEquals(validIdCopyPath("PM-ABC123", p), true);
  assertEquals(validIdCopyPath("PM-OTHER1", p), false);
  assertEquals(idCopyPath("PM-ABC123", "image/gif"), null);
  assertEquals(validIdCopyPath("PM-ABC123", "PM-ABC123/../PM-X/idcopy-a.pdf"), false);
  assertEquals(validIdCopyPath("PM-ABC123", "PM-ABC123/idcopy-not-a-uuid.pdf"), false);
  assertEquals(validIdCopyPath("PM-ABC123", "PM-ABC123/photo-1b4e28ba-2fa1-11d2-883f-0016d3cca427.jpg"), false);
  assertEquals(validIdCopyPath("PM-ABC123", "PM-ABC123/consent-1b4e28ba-2fa1-11d2-883f-0016d3cca427.pdf"), false);
  assertEquals(validIdCopyPath("PM-ABC123", 42), false);
});

Deno.test("the client's own ID copy: the back has its own path; only while it is the client's turn, never over a consultant's", () => {
  // Michael, 2026-10-20 (late): the client may add their ID on the form — front, and the back as a second picture.
  const back = idBackPath("PM-ABC123", "image/jpeg")!;
  const front = idCopyPath("PM-ABC123", "image/jpeg")!;
  assertEquals(validIdBackPath("PM-ABC123", back), true);
  assertEquals(validIdBackPath("PM-OTHER1", back), false);
  // A back can never stand in for the front the credit-check gate looks for, nor the other way round.
  assertEquals(validIdCopyPath("PM-ABC123", back), false);
  assertEquals(validIdBackPath("PM-ABC123", front), false);
  assertEquals(idBackPath("PM-ABC123", "image/gif"), null);
  assertEquals(validIdBackPath("PM-ABC123", "PM-ABC123/idback-not-a-uuid.jpg"), false);
  assertEquals(validIdBackPath("PM-ABC123", "PM-ABC123/../PM-X/idback-1b4e28ba-2fa1-11d2-883f-0016d3cca427.jpg"), false);
  assertEquals(validIdBackPath("PM-ABC123", undefined), false);
  for (const st of CLIENT_ID_COPY_FROM) assertEquals(clientIdCopyCheck({ status: st }).ok, true, st);
  assertEquals(clientIdCopyCheck({ status: "check_in_flight" }), { ok: false, reason: "id_copy_busy" });
  for (const st of ["manual_verified", "report_ready", "check_failed", "consent_withdrawn", "expired", "config_error", "report_requested"]) {
    assertEquals(clientIdCopyCheck({ status: st }), { ok: false, reason: "id_copy_locked" }, st);
  }
  // One attach per application: any copy on the record, whoever attached it, closes the client's window.
  assertEquals(clientIdCopyCheck({ status: "idv_passed", id_document_path: "PM-X/idcopy-a.jpg", id_document_source: "staff" }), { ok: false, reason: "id_copy_present" });
  assertEquals(clientIdCopyCheck({ status: "idv_passed", id_document_path: "PM-X/idcopy-a.jpg", id_document_source: "client" }), { ok: false, reason: "id_copy_present" });
  assertEquals(clientIdCopyCheck({ status: "idv_passed", id_document_path: null, id_document_source: null }).ok, true);
  // A declared type is looked up as an own key only — never an inherited one.
  for (const bad of ["constructor", "__proto__", "toString", "hasOwnProperty", ""]) {
    assertEquals(idCopyPath("PM-ABC123", bad), null, bad);
    assertEquals(idBackPath("PM-ABC123", bad), null, bad);
  }
});

Deno.test("signed consent form: its own path, never interchangeable with the ID copy", () => {
  // MortgageMAX, 2026-10-01: the manual route needs the client's signed Consent Form as well.
  assertEquals(CONSENT_FORM.version, "mmax-consent-form-2025-11");
  const form = consentFormPath("PM-ABC123", "image/jpeg")!;
  const idCopy = idCopyPath("PM-ABC123", "image/jpeg")!;
  assertEquals(validConsentFormPath("PM-ABC123", form), true);
  assertEquals(validConsentFormPath("PM-OTHER1", form), false);
  // An upload made as one kind cannot be passed off as the other.
  assertEquals(validConsentFormPath("PM-ABC123", idCopy), false);
  assertEquals(validIdCopyPath("PM-ABC123", form), false);
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
