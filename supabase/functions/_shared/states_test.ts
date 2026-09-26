// Parity: the browser (assets/store.js) and the server (states.ts) must agree on who can run a check,
// and every status the DB allows must have a label in the admin UI.
import { assertEquals } from "jsr:@std/assert@1";
import {
  ALL_STATUSES,
  allowedFrom,
  configErrorTarget,
  IDV_ANSWER_WINDOW_MS,
  STALE_IN_FLIGHT_MS,
  staleState,
} from "./states.ts";

function loadStore() {
  const src = Deno.readTextFileSync(new URL("../../../assets/store.js", import.meta.url));
  const mem: Record<string, string> = {};
  const storage = { getItem: (k: string) => mem[k] ?? null, setItem: (k: string, v: string) => { mem[k] = v; }, removeItem: (k: string) => { delete mem[k]; } };
  const win: Record<string, unknown> = { PM_CONFIG: {}, location: { search: "?demo=1", hostname: "localhost" }, addEventListener: () => {} };
  new Function("window", "localStorage", "sessionStorage", src)(win, storage, storage);
  return win.PMStore as { allowedFrom: (m: string, f: boolean) => string[]; STATUS: Record<string, unknown>; mode: string };
}

Deno.test("store.js allowedFrom === server allowedFrom for every mode × force", () => {
  const store = loadStore();
  assertEquals(store.mode, "demo");
  for (const mode of ["off", "optional", "required"] as const) {
    for (const force of [false, true]) {
      assertEquals([...store.allowedFrom(mode, force)].sort(), [...allowedFrom(mode, force)].sort(), `${mode}/${force}`);
    }
  }
});

Deno.test("every DB status has an admin label, and no label is for a status the DB rejects", () => {
  const store = loadStore();
  assertEquals(Object.keys(store.STATUS).sort(), [...ALL_STATUSES].sort());
});

Deno.test("migration CHECK constraint lists exactly ALL_STATUSES", () => {
  const sql = Deno.readTextFileSync(new URL("../../migrations/20260926_mortgagemax.sql", import.meta.url));
  const block = sql.slice(sql.indexOf("check (status in ("), sql.indexOf("));", sql.indexOf("check (status in (")));
  const found = [...block.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  assertEquals(found.sort(), [...ALL_STATUSES].sort());
});

Deno.test("staleState: check_in_flight past 5 min and idv_in_progress past the answer window", () => {
  const now = Date.parse("2026-09-26T12:00:00Z");
  const ago = (ms: number) => new Date(now - ms).toISOString();
  assertEquals(staleState({ status: "check_in_flight", check_started_at: ago(STALE_IN_FLIGHT_MS + 1) }, now), "check_in_flight");
  assertEquals(staleState({ status: "check_in_flight", check_started_at: ago(60_000) }, now), null);
  assertEquals(staleState({ status: "check_in_flight", check_started_at: null }, now), "check_in_flight");
  assertEquals(staleState({ status: "idv_in_progress", idv_started_at: ago(IDV_ANSWER_WINDOW_MS + 1) }, now), "idv_in_progress");
  assertEquals(staleState({ status: "idv_in_progress", idv_started_at: ago(IDV_ANSWER_WINDOW_MS - 1000) }, now), null);
  assertEquals(staleState({ status: "idv_in_progress" }, now), "idv_in_progress");
  assertEquals(staleState({ status: "idv_failed", idv_started_at: ago(10 * 60_000) }, now), null);
  assertEquals(staleState({ status: "report_ready", check_started_at: ago(10 * 60_000) }, now), null);
});

Deno.test("configErrorTarget: derived from the row's own data, only into existing statuses", () => {
  const t = (row: Record<string, unknown>, mode: "off" | "optional" | "required" = "off") => configErrorTarget(row, mode).status;
  assertEquals(t({ report_json: { a: 1 }, check_started_at: "x" }), "report_ready");
  const failed = configErrorTarget({ check_started_at: "2026-09-26T10:00:00Z", consent_registered_at: "x" }, "off");
  assertEquals(failed.status, "check_failed");
  assertEquals(failed.patch.check_error_code, "config_error_cleared");
  assertEquals(t({ consent_registered_at: null }), "consent_confirmed");
  assertEquals(t({ consent_registered_at: "x", idv_passed_at: "y", idv_attempts: 1 }, "required"), "idv_passed");
  assertEquals(t({ consent_registered_at: "x", idv_attempts: 1 }, "optional"), "idv_failed");
  assertEquals(t({ consent_registered_at: "x", idv_attempts: 0 }, "off"), "idv_waived");
  assertEquals(t({ consent_registered_at: "x", idv_attempts: 0 }, "required"), "consent_registered");
  for (const row of [{}, { report_json: {} }, { check_started_at: "x" }, { consent_registered_at: "x" }]) {
    for (const mode of ["off", "optional", "required"] as const) {
      const st = configErrorTarget(row, mode).status;
      assertEquals(ALL_STATUSES.includes(st) && st !== "config_error", true, `${JSON.stringify(row)}/${mode} → ${st}`);
    }
  }
});
