#!/usr/bin/env node
// Staff-path smoke test for mm-staff. The staff email + password are typed HERE, in your terminal,
// and go straight to Supabase Auth — they are never printed, logged or saved. Runs against whatever
// MM_MODE the project is in (mock by default: no vendor call, no bureau enquiry).
//
//   node scripts/smoke-staff.mjs PM-XXXXXX
import readline from "node:readline";

const URL_BASE = "https://mxakigcvckhmyppoiuds.supabase.co";
const KEY = "sb_publishable_DrNDeaB_61zFz27q1QzW_w_PkiKd-AO"; // public by design
const ref = process.argv[2];
if (!ref) { console.error("usage: node scripts/smoke-staff.mjs PM-XXXXXX"); process.exit(1); }

function ask(q, hidden = false) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) rl._writeToOutput = (s) => { if (!s.startsWith(q)) rl.output.write(s.includes("\n") ? "\n" : ""); else rl.output.write(q); };
    rl.question(q, (a) => { rl.close(); resolve(a.trim()); });
  });
}

const email = await ask("Staff email: ");
const password = await ask("Password (hidden): ", true);

const auth = await fetch(`${URL_BASE}/auth/v1/token?grant_type=password`, {
  method: "POST",
  headers: { apikey: KEY, "Content-Type": "application/json" },
  body: JSON.stringify({ email, password }),
}).then((r) => r.json());
if (!auth.access_token) { console.error("\n✗ Sign-in failed:", auth.error_description ?? auth.msg ?? "unknown"); process.exit(1); }
console.log("\n✓ Signed in as", auth.user?.email);

async function call(action, extra = {}) {
  const r = await fetch(`${URL_BASE}/functions/v1/mm-staff`, {
    method: "POST",
    headers: { apikey: KEY, Authorization: `Bearer ${auth.access_token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ref, action, ...extra }),
  });
  const j = await r.json().catch(() => ({}));
  return { http: r.status, ...j };
}

const show = (label, r) => console.log(`${r.ok ? "✓" : "✗"} ${label.padEnd(18)} HTTP ${r.http}  ${JSON.stringify(r.ok ? r.data : r.error)}`);

show("run-check", await call("run-check"));
{ // must be REFUSED: the record is already report_ready (no double billing)
  const again = await call("run-check");
  console.log(`${!again.ok && again.http === 409 ? "✓" : "✗"} ${"run-check again".padEnd(18)} HTTP ${again.http}  (expected to be refused) ${JSON.stringify(again.error ?? again.data)}`);
}
show("fetch-pdf", await call("fetch-pdf"));
show("refresh-consents", await call("refresh-consents"));

// Staff must NOT be able to change status directly any more (migration D10).
const direct = await fetch(`${URL_BASE}/rest/v1/credit_checks?ref=eq.${ref}`, {
  method: "PATCH",
  headers: { apikey: KEY, Authorization: `Bearer ${auth.access_token}`, "Content-Type": "application/json", Prefer: "return=representation" },
  body: JSON.stringify({ status: "awaiting_otp" }),
});
console.log(`${direct.status >= 400 ? "✓" : "✗"} direct status edit  HTTP ${direct.status} (expected to be denied)`);

// Staff CAN read the report back (what admin.html will do), and sign a PDF URL.
const row = await fetch(`${URL_BASE}/rest/v1/credit_checks?ref=eq.${ref}&select=status,group_id,pdf_status,report_pdf_path,report_summary`, {
  headers: { apikey: KEY, Authorization: `Bearer ${auth.access_token}` },
}).then((r) => r.json());
const rec = row[0] ?? {};
console.log(`${rec.status === "report_ready" ? "✓" : "✗"} staff read-back     status=${rec.status} pdf=${rec.pdf_status} score=${rec.report_summary?.score} rag=${rec.report_summary?.rag}`);
if (rec.report_pdf_path) {
  const s = await fetch(`${URL_BASE}/storage/v1/object/sign/credit-reports/${rec.report_pdf_path}`, {
    method: "POST",
    headers: { apikey: KEY, Authorization: `Bearer ${auth.access_token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ expiresIn: 60 }),
  });
  console.log(`${s.ok ? "✓" : "✗"} signed PDF URL      HTTP ${s.status}`);
}
console.log("\nDone. Nothing was saved locally.");
