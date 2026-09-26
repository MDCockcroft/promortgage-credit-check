import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { loaderCache } from "./cache.ts";

function clock() {
  let t = 1_000_000;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

Deno.test("loaderCache: success cached for okMs; fresh always reloads", async () => {
  const c = clock();
  const cache = loaderCache<number>(60_000, 5_000, c.now);
  let calls = 0;
  const load = () => Promise.resolve(++calls);
  assertEquals(await cache.get("live", load), 1);
  assertEquals(await cache.get("live", load), 1);
  assertEquals(await cache.get("live", load, { fresh: true }), 2);
  c.advance(60_001);
  assertEquals(await cache.get("live", load), 3);
  assertEquals(await cache.get("mock", load), 4); // keyed
});

Deno.test("loaderCache: a failure is cached for failMs (negative cache), then retried", async () => {
  const c = clock();
  const cache = loaderCache<string>(60_000, 60_000, c.now);
  let calls = 0;
  let fail = true;
  const load = () => {
    calls++;
    return fail ? Promise.reject(new Error("vendor_error: 503")) : Promise.resolve("types");
  };
  await assertRejects(() => cache.get("live", load), Error, "vendor_error");
  // 100 anonymous requests inside the window → zero further vendor calls.
  for (let i = 0; i < 100; i++) await assertRejects(() => cache.get("live", load), Error, "vendor_error");
  assertEquals(calls, 1);
  fail = false;
  c.advance(59_000);
  await assertRejects(() => cache.get("live", load));
  assertEquals(calls, 1);
  c.advance(1_001);
  assertEquals(await cache.get("live", load), "types");
  assertEquals(calls, 2);
});

Deno.test("loaderCache: a failed fresh reload keeps serving the last good copy to cached reads", async () => {
  const c = clock();
  const cache = loaderCache<string>(60_000, 60_000, c.now);
  assertEquals(await cache.get("live", () => Promise.resolve("v13")), "v13");
  await assertRejects(() => cache.get("live", () => Promise.reject(new Error("down")), { fresh: true }));
  assertEquals(await cache.get("live", () => Promise.reject(new Error("unused"))), "v13");
});

Deno.test("cache: single-flight — concurrent non-fresh gets share one load", async () => {
  const { loaderCache } = await import("./cache.ts");
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const c = loaderCache<string>(1000, 1000);
  const load = async () => { calls++; await gate; return "v"; };
  const ps = Array.from({ length: 20 }, () => c.get("k", load));
  release();
  const vals = await Promise.all(ps);
  if (calls !== 1) throw new Error(`expected 1 load, got ${calls}`);
  if (!vals.every((v) => v === "v")) throw new Error("wrong values");
});

Deno.test("cache: stale-on-error — expired good copy served when the reload fails; fresh never gets it", async () => {
  const { loaderCache } = await import("./cache.ts");
  let t = 0;
  const c = loaderCache<string>(10, 5, () => t);
  await c.get("k", async () => "v13");
  t = 100; // good copy expired
  const v = await c.get("k", async () => { throw new Error("vendor 503"); });
  if (v !== "v13") throw new Error("expected stale v13");
  let threw = false;
  try { await c.get("k", async () => { throw new Error("vendor 503"); }, { fresh: true }); } catch { threw = true; }
  if (!threw) throw new Error("fresh read must not fall back to stale");
});
