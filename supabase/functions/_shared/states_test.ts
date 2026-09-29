// Parity: the browser (assets/store.js) and the server (states.ts) must agree on who can run a check,
// and every status the DB allows must have a label in the admin UI.
import { assertEquals } from "jsr:@std/assert@1";
import {
  ALL_STATUSES,
  allowedFrom,
  configErrorTarget,
  IDV_ANSWER_WINDOW_MS,
  idvLinkCheck,
  idvModeFrom,
  MAX_IDV_ROUNDS,
  STALE_IN_FLIGHT_MS,
  staleState,
} from "./states.ts";
import { ATTESTATION, manualVerifyCheck } from "./manual.ts";
import { validLinkCode } from "./access.ts";

function loadStore() {
  const src = Deno.readTextFileSync(new URL("../../../assets/store.js", import.meta.url));
  const mem: Record<string, string> = {};
  const storage = { getItem: (k: string) => mem[k] ?? null, setItem: (k: string, v: string) => { mem[k] = v; }, removeItem: (k: string) => { delete mem[k]; } };
  const win: Record<string, unknown> = { PM_CONFIG: {}, location: { search: "?demo=1", hostname: "localhost" }, addEventListener: () => {} };
  new Function("window", "localStorage", "sessionStorage", src)(win, storage, storage);
  return win.PMStore as {
    allowedFrom: (m: string) => string[]; STATUS: Record<string, unknown>; mode: string;
    ATTESTATION: { version: string; text: string };
    manualVerifyCheck: (rec: Record<string, unknown>) => { ok: boolean; reason?: string };
    idvLinkCheck: (rec: Record<string, unknown>, mode: string) => { ok: boolean; reason?: string };
    MAX_IDV_ROUNDS: number;
    validLinkCode: (v: unknown) => boolean;
    consultantCode: string | null;
  };
}

Deno.test("store.js allowedFrom === server allowedFrom for every mode", () => {
  const store = loadStore();
  assertEquals(store.mode, "demo");
  for (const mode of ["off", "required"] as const) {
    assertEquals([...store.allowedFrom(mode)].sort(), [...allowedFrom(mode)].sort(), mode);
  }
});

Deno.test("required mode: a check runs only after the identity questions or manual verification", () => {
  assertEquals([...allowedFrom("required")].sort(), ["check_failed", "idv_passed", "manual_verified"]);
  // The removed 'optional' override fails safe to required; anything unknown is off (mock/demo).
  assertEquals(idvModeFrom("optional"), "required");
  assertEquals(idvModeFrom("required"), "required");
  assertEquals(idvModeFrom(undefined), "off");
  assertEquals(idvModeFrom("REQUIRED"), "off");
});

Deno.test("every DB status has an admin label, and no label is for a status the DB rejects", () => {
  const store = loadStore();
  assertEquals(Object.keys(store.STATUS).sort(), [...ALL_STATUSES].sort());
});

Deno.test("the LATEST migration's CHECK constraint lists exactly ALL_STATUSES", () => {
  const dir = new URL("../../migrations/", import.meta.url);
  const files = [...Deno.readDirSync(dir)].map((e) => e.name).filter((n) => n.endsWith(".sql")).sort();
  const latest = files.filter((n) => Deno.readTextFileSync(new URL(n, dir)).includes("check (status in (")).pop()!;
  assertEquals(latest, "20260929_manual_verification.sql");
  const sql = Deno.readTextFileSync(new URL(latest, dir));
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
  const t = (row: Record<string, unknown>, mode: "off" | "required" = "off") => configErrorTarget(row, mode).status;
  assertEquals(t({ report_json: { a: 1 }, check_started_at: "x" }), "report_ready");
  const failed = configErrorTarget({ check_started_at: "2026-09-26T10:00:00Z", consent_registered_at: "x" }, "off");
  assertEquals(failed.status, "check_failed");
  assertEquals(failed.patch.check_error_code, "config_error_cleared");
  assertEquals(t({ consent_registered_at: null }), "consent_confirmed");
  assertEquals(t({ consent_registered_at: "x", idv_passed_at: "y", idv_attempts: 1 }, "required"), "idv_passed");
  assertEquals(t({ consent_registered_at: "x", idv_attempts: 1 }, "required"), "idv_failed");
  assertEquals(t({ consent_registered_at: "x", idv_attempts: 1, manual_verified_at: "y" }, "required"), "manual_verified");
  assertEquals(t({ consent_registered_at: "x", idv_attempts: 0 }, "off"), "idv_waived");
  assertEquals(t({ consent_registered_at: "x", idv_attempts: 0 }, "required"), "consent_registered");
  for (const row of [{}, { report_json: {} }, { check_started_at: "x" }, { consent_registered_at: "x" }]) {
    for (const mode of ["off", "required"] as const) {
      const st = configErrorTarget(row, mode).status;
      assertEquals(ALL_STATUSES.includes(st) && st !== "config_error", true, `${JSON.stringify(row)}/${mode} → ${st}`);
    }
  }
});

Deno.test("store.js attestation wording and manual-verification rule === server (manual.ts)", () => {
  const store = loadStore();
  assertEquals(store.ATTESTATION, { ...ATTESTATION });
  for (const status of [...ALL_STATUSES]) {
    for (const idType of ["said", "passport"]) {
      for (const registered of [null, "2026-09-28T10:00:00Z"]) {
        for (const withdrawn of [null, "2026-09-28T11:00:00Z"]) {
          const server = manualVerifyCheck({ status, id_type: idType, consent_registered_at: registered, consent_withdrawn_at: withdrawn });
          const browser = store.manualVerifyCheck({ status, idType, consentRegisteredAt: registered, consentWithdrawnAt: withdrawn });
          assertEquals(browser, server, `${status}/${idType}/${registered}/${withdrawn}`);
        }
      }
    }
  }
});

Deno.test("idv link re-issue: required mode only, a round left, SA ID, no withdrawal — and store.js agrees", () => {
  const store = loadStore();
  assertEquals(store.MAX_IDV_ROUNDS, MAX_IDV_ROUNDS);
  const row = (x: Record<string, unknown>) => ({ id_type: "said", status: "consent_registered", ...x });
  assertEquals(idvLinkCheck(row({}), "required").ok, true);
  assertEquals(idvLinkCheck(row({}), "off"), { ok: false, reason: "idv_off" });
  assertEquals(idvLinkCheck(row({ status: "idv_failed", idv_attempts: 1 }), "required").ok, true);
  assertEquals(idvLinkCheck(row({ status: "idv_failed", idv_attempts: MAX_IDV_ROUNDS }), "required").ok, false);
  assertEquals(idvLinkCheck(row({ id_type: "passport" }), "required").ok, false);
  assertEquals(idvLinkCheck(row({ consent_withdrawn_at: "x" }), "required").ok, false);
  for (const status of [...ALL_STATUSES]) {
    for (const attempts of [0, 1, 2]) {
      for (const idType of ["said", "passport"]) {
        for (const mode of ["off", "required"] as const) {
          const server = idvLinkCheck({ status, id_type: idType, idv_attempts: attempts }, mode);
          const browser = store.idvLinkCheck({ status, idType, idvAttempts: attempts }, mode);
          assertEquals(browser, server, `${status}/${attempts}/${idType}/${mode}`);
        }
      }
    }
  }
});

Deno.test("store.js link-code rule === server (access.ts); no code without a link", () => {
  const store = loadStore();
  assertEquals(store.consultantCode, null);
  for (const v of ["k7m2pq3x", "abcdefgh", "23456789", "K7M2PQ3X", "k7m2pq", "k7m2pq3xy", "k7m2pq30", "k7m2pq31", "k7m2pq3l", "k7m2pq3o", "k7m2pq3i", "", " k7m2pq3x", null, 12345678]) {
    assertEquals(store.validLinkCode(v), validLinkCode(v), String(v));
  }
});
