import { assert, assertEquals } from "jsr:@std/assert@1";
import { base64ToBytes, flag, num, pdfIsEncrypted, summarise } from "./report.ts";
import { MOCK_REPORT } from "./mock.ts";

Deno.test("flag: explicit allow-list — 'false' is NOT truthy, unknown stays unknown", () => {
  assertEquals(flag("false"), "no");
  assertEquals(flag("N"), "no");
  assertEquals(flag("Y"), "yes");
  assertEquals(flag(true), "yes");
  assertEquals(flag("Maybe"), "unknown");
  assertEquals(flag(null), "unknown");
});

Deno.test("num: strips R, spaces and commas; rejects junk", () => {
  assertEquals(num("R1,450,000.00"), 1450000);
  assertEquals(num("1 450 000"), 1450000);
  assertEquals(num(642), 642);
  assertEquals(num("n/a"), null);
  assertEquals(num(""), null);
});

Deno.test("summarise: mock full report → Tier 1 verdict", () => {
  const s = summarise(MOCK_REPORT);
  assertEquals(s.score, 642);
  assertEquals(s.riskType, "Medium");
  assertEquals(s.riskColour, "rgb(255, 191, 0)");
  assertEquals(s.rag, "Amber");
  assertEquals(s.thinFile, "no");
  assertEquals(s.flags.deceased, "no");
  assertEquals(s.counts.judgements, 0);
  assertEquals(s.affordability.amount, 1450000);
  assertEquals(s.enquiryId, "MOCK-ENQ-0001");
});

Deno.test("summarise: empty / errored response never throws", () => {
  const s = summarise({ errorCode: "E1" });
  assertEquals(s.score, null);
  assertEquals(s.affordability.present, false);
  assertEquals(s.flags.fraud, "unknown");
  assertEquals(summarise(null).counts.adverse, null);
});

Deno.test("summarise: counts are null when a bureau section is absent, 0 only when present and empty", () => {
  const withRes = (res: unknown) => summarise({ groupId: "G", experianCreditCheckData: { cC_RESULTS: res } });
  // No cC_RESULTS at all → every count unknown.
  const none = summarise({ groupId: "G", experianCreditCheckData: {} });
  for (const v of Object.values(none.counts)) assertEquals(v, null);
  assertEquals(withRes(null).counts.judgements, null);
  // Section present but null / not a list → unknown.
  const partial = withRes({ enqCC_JUDGEMENTS: null, enqCC_ADVERSE: "0", enqCC_NOTICES: [] });
  assertEquals(partial.counts.judgements, null);
  assertEquals(partial.counts.adverse, null);
  assertEquals(partial.counts.publicDefaults, null); // key absent
  assertEquals(partial.counts.notices, 0); // present and empty
  // Present with rows → the row count.
  assertEquals(withRes({ enqCC_COLLECTIONS: [{}, {}] }).counts.collections, 2);
  // The full mock report has every section present and empty.
  assertEquals(Object.values(summarise(MOCK_REPORT).counts), [0, 0, 0, 0, 0, 0]);
});

Deno.test("pdf: base64 decode + /Encrypt detection", () => {
  const plain = base64ToBytes(btoa("%PDF-1.4 hello %%EOF"));
  assertEquals(pdfIsEncrypted(plain), false);
  assert(pdfIsEncrypted(new TextEncoder().encode("%PDF-1.4 trailer<</Encrypt 5 0 R>>")));
});
