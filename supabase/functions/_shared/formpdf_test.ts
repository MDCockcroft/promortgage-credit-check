import { assertEquals, assertMatch } from "jsr:@std/assert@1";

/** store.js runs in a bare window; buildFormPdf needs nothing from the DOM. */
function loadStore() {
  const src = Deno.readTextFileSync(new URL("../../../assets/store.js", import.meta.url));
  const mem: Record<string, string> = {};
  const storage = { getItem: (k: string) => mem[k] ?? null, setItem: (k: string, v: string) => { mem[k] = v; }, removeItem: (k: string) => { delete mem[k]; } };
  const win: Record<string, unknown> = { PM_CONFIG: {}, location: { search: "?demo=1", hostname: "localhost" }, addEventListener: () => {} };
  new Function("window", "localStorage", "sessionStorage", src)(win, storage, storage);
  return win.PMStore as { buildFormPdf: (rec: Record<string, unknown>, opts?: Record<string, unknown>) => Uint8Array };
}

const rec = {
  ref: "PM-TEST01", createdAt: Date.parse("2026-10-12T09:30:00+02:00"), status: "idv_passed",
  firstNames: "Thandi Zoë", surname: "Mokoena–Smith", idType: "said", idNumber: "9302170340096",
  email: "thandi@example.com", cell: "0821234567", homePhone: "", workPhone: "0123456789",
  street: "7B Protea Street", suburb: "Umhlanga Rocks", city: "Durban", province: "KwaZulu-Natal", postalCode: "4320",
  employmentStatus: "Full-time employed", maritalStatus: "Single", referral: "Google search",
  grossIncome: 41500, totalDeductions: 9300, monthlyExpenses: 14200, housingPayment: 8500,
  consentConfirmedAt: Date.parse("2026-10-12T09:31:00+02:00"), consentRegisteredAt: Date.parse("2026-10-12T09:31:05+02:00"),
  consentUA: "Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) 😀",
  consentsPresented: [{ id: "818BB417-1111-2222-3333-444444444444", name: "Broad consent MM", version: 13, hash: "abcdef0123456789abcdef" }],
};
const decls = [{ id: "818bb417-1111-2222-3333-444444444444", name: "Broad consent MM", version: 13, isHtml: true,
  declaration: "<p>I, the undersigned, consent to <strong>MortgageMAX</strong> obtaining my credit report.</p><p>Second paragraph &amp; more.</p>" }];

Deno.test("buildFormPdf: a valid single-file PDF with correct cross-reference offsets", () => {
  const bytes = loadStore().buildFormPdf(rec, { consultant: "Bongi Dlamini", generatedBy: "Ada Admin", declarations: decls });
  const s = new TextDecoder("latin1").decode(bytes);
  assertMatch(s, /^%PDF-1\.4\n/);
  assertMatch(s, /%%EOF\n$/);
  // the xref table lists every object at the byte where "<n> 0 obj" really starts
  const startxref = Number(s.match(/startxref\n(\d+)\n/)![1]);
  assertEquals(s.slice(startxref, startxref + 4), "xref");
  const count = Number(s.match(/xref\n0 (\d+)\n/)![1]);
  const table = s.slice(s.indexOf("xref\n")).split("\n").slice(2, 2 + count);
  for (let i = 1; i < count; i++) {
    const off = Number(table[i].slice(0, 10));
    assertEquals(s.slice(off, off + String(i).length + 6), `${i} 0 obj`, `object ${i}`);
  }
  assertMatch(s, /\/Count (\d+) >>/);
  // every byte is one character (WinAnsi): nothing above 0xFF survived, the emoji became '?'
  for (const b of bytes) if (b > 0xff) throw new Error("multi-byte");
  assertEquals(s.includes("Mokoena-Smith"), true); // the en dash became a hyphen
  assertEquals(s.includes("Zo\xeb"), true);          // Latin-1 letters are kept
  assertEquals(s.includes("obtaining my credit report."), true); // the declaration text, HTML stripped
  assertEquals(s.includes("Second paragraph & more."), true);
  assertEquals(s.includes("Bongi Dlamini"), true);
  // every content stream's /Length matches its bytes
  for (const m of s.matchAll(/<< \/Length (\d+) >>\nstream\n/g)) {
    const start = m.index! + m[0].length;
    assertEquals(s.slice(start + Number(m[1]), start + Number(m[1]) + 10), "\nendstream");
  }
  // a sample for a human to look at
  Deno.writeFileSync(Deno.env.get("FORM_PDF_OUT") ?? "/dev/null", bytes);
});

Deno.test("buildFormPdf: a long declaration flows onto more than one page; no wording is still a PDF", () => {
  const store = loadStore();
  const long = { ...decls[0], declaration: "<p>" + "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(120) + "</p>" };
  const s = new TextDecoder("latin1").decode(store.buildFormPdf(rec, { declarations: [long] }));
  assertEquals(Number(s.match(/\/Count (\d+) >>/)![1]) >= 2, true);
  const bare = new TextDecoder("latin1").decode(store.buildFormPdf({ ...rec, consentsPresented: [], consentUA: "" }));
  assertMatch(bare, /^%PDF-1\.4\n/);
  assertEquals(bare.includes("was not recorded"), true);
});
