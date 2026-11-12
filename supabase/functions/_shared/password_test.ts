import { assert, assertEquals } from "jsr:@std/assert@1";
import { newLoginInput, oneTimePassword } from "./password.ts";

Deno.test("one-time passwords meet the sign-in rules and differ", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const p = oneTimePassword();
    assert(/^[a-zA-Z2-9]{4}(-[a-zA-Z2-9]{4}){3}$/.test(p), p);
    assert(p.length >= 12 && /[a-z]/.test(p) && /[A-Z]/.test(p) && /[0-9]/.test(p) && /[^A-Za-z0-9]/.test(p), p);
    assert(!/[ilo01IO]/.test(p), `look-alike in ${p}`);
    seen.add(p);
  }
  assertEquals(seen.size, 200);
});

Deno.test("a new login's details are cleaned", () => {
  assertEquals(newLoginInput({ fullName: "  Thandi   Mokoena ", email: " Thandi@Example.com ", cell: "082 555 0101", role: "consultant" }),
    { ok: true, fullName: "Thandi Mokoena", email: "thandi@example.com", cell: "0825550101", role: "consultant" });
  assertEquals(newLoginInput({ fullName: "Kobus B", email: "k@example.co.za", cell: "+27825550101", role: "admin" }),
    { ok: true, fullName: "Kobus B", email: "k@example.co.za", cell: "0825550101", role: "admin" });
  assertEquals(newLoginInput({ fullName: "Kobus B", email: "k@example.co.za", role: "admin" }),
    { ok: true, fullName: "Kobus B", email: "k@example.co.za", cell: null, role: "admin" });
});

Deno.test("a new login's details are refused by field", () => {
  const good = { fullName: "Thandi Mokoena", email: "t@example.com", cell: "", role: "consultant" };
  const field = (over: Record<string, unknown>) => {
    const r = newLoginInput({ ...good, ...over });
    return r.ok ? "ok" : r.field;
  };
  assertEquals(field({}), "ok");
  assertEquals(field({ fullName: "T" }), "fullName");
  assertEquals(field({ fullName: "<b>Thandi</b>" }), "fullName");
  assertEquals(field({ fullName: 7 }), "fullName");
  assertEquals(field({ email: "not-an-address" }), "email");
  assertEquals(field({ email: "a@b" }), "email");
  assertEquals(field({ email: "a b@example.com" }), "email");
  assertEquals(field({ cell: "12345" }), "cell");
  assertEquals(field({ cell: 825550101 }), "cell");
  assertEquals(field({ role: "owner" }), "role");
  assertEquals(field({ role: undefined }), "role");
});
