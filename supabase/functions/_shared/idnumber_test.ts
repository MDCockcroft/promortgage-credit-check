import { assert, assertEquals } from "jsr:@std/assert@1";
import { idProblem, idvIdType, personIdFor, validSaId } from "./idnumber.ts";

/** Append the Luhn check digit to 12 digits (independent of validSaId's date rule). */
function withCheckDigit(first12: string): string {
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    let d = Number(first12[11 - i]);
    if (i % 2 === 0) { d *= 2; if (d > 9) d -= 9; } // doubled positions, counting from the check digit
    sum += d;
  }
  return first12 + String((10 - (sum % 10)) % 10);
}
const GOOD = withCheckDigit("800101500908");

Deno.test("validSaId: 13 digits, plausible month/day, Luhn check digit", () => {
  assert(validSaId(GOOD));
  assertEquals(validSaId("8001015009087"), GOOD === "8001015009087");
  const wrongDigit = GOOD.slice(0, 12) + String((Number(GOOD[12]) + 1) % 10);
  assertEquals(validSaId(wrongDigit), false);
  assertEquals(validSaId(GOOD.slice(0, 12)), false); // 12 digits
  assertEquals(validSaId(GOOD + "0"), false); // 14 digits
  assertEquals(validSaId("80O1015009087"), false); // letter O
  assertEquals(validSaId(withCheckDigit("801301500908")), false); // month 13
  assertEquals(validSaId(withCheckDigit("800100500908")), false); // day 00
  assertEquals(validSaId(null), false);
  assertEquals(validSaId(8001015009087), false);
});

Deno.test("personIdFor: always the column id_type names — never mm_person_id", () => {
  assertEquals(personIdFor({ id_type: "said", id_number: GOOD, passport_number: "X123", mm_person_id: "X123" }), GOOD);
  assertEquals(personIdFor({ id_type: "passport", id_number: GOOD, passport_number: " X123 ", mm_person_id: GOOD }), "X123");
  assertEquals(personIdFor({ id_type: "said", id_number: "", passport_number: "X123", mm_person_id: "X123" }), "");
  assertEquals(personIdFor({ id_type: "other", id_number: GOOD }), "");
});

Deno.test("idProblem: SA ID must be valid and equal mm_person_id; passport needs a number", () => {
  assertEquals(idProblem({ id_type: "said", id_number: GOOD, mm_person_id: GOOD }), null);
  // Passport-gate bypass (finding 28): said + passport number, no ID number.
  assert(idProblem({ id_type: "said", id_number: "", passport_number: "X123", mm_person_id: "X123" }));
  assert(idProblem({ id_type: "said", id_number: "1234567890123", mm_person_id: "1234567890123" }));
  assert(idProblem({ id_type: "said", id_number: GOOD, mm_person_id: "9999999999999" }));
  assertEquals(idProblem({ id_type: "passport", passport_number: "X123", mm_person_id: "X123" }), null);
  assert(idProblem({ id_type: "passport", passport_number: "" }));
  assert(idProblem({ id_type: "unknown" }));
});

Deno.test("idvIdType: SAID for SA ID rows, PASSPORT for passport rows", () => {
  assertEquals(idvIdType({ id_type: "said" }), "SAID");
  assertEquals(idvIdType({ id_type: "passport" }), "PASSPORT");
});
