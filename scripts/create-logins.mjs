#!/usr/bin/env node
// Create staff logins from a CSV, complete: the Auth login (confirmed), the role (staff_members, so
// the personal link exists at once) and the details (staff_profiles: name, email, cell), so each
// consultant can sign in and send their link straight away. The CSV lives OUTSIDE this repo (it
// holds names and cellphone numbers): full_name,email,cell,role — role is admin or consultant and
// defaults to consultant.
// The service-role key is typed HERE (hidden) and never printed, logged or saved. Each new login's
// password is generated and shown ONCE, for you to pass on by phone. A login that already exists is
// left alone (no new password); its role and details are still filled in if they are missing.
// Every new login must choose its own password at first sign-in (must_change_password). Add
// --require-change to put the same requirement on logins in the CSV that already exist.
//
//   node scripts/create-logins.mjs "/path/to/staff-logins.csv"
import fs from "node:fs";
import readline from "node:readline";
import { randomBytes } from "node:crypto";

const URL_BASE = "https://mxakigcvckhmyppoiuds.supabase.co";
const SITE = "https://check.promortgagesa.co.za";
const csvPath = process.argv[2];
const REQUIRE_CHANGE = process.argv.includes("--require-change"); // also flag logins that already exist
if (!csvPath || !fs.existsSync(csvPath)) { console.error('usage: node scripts/create-logins.mjs "/path/to/staff-logins.csv"'); process.exit(1); }

function ask(q, hidden = false) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) rl._writeToOutput = (s) => { if (!s.startsWith(q)) rl.output.write(s.includes("\n") ? "\n" : ""); else rl.output.write(q); };
    rl.question(q, (a) => { rl.close(); resolve(a.trim()); });
  });
}

// --- the list ---------------------------------------------------------------------------------
const rows = fs.readFileSync(csvPath, "utf8").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
const header = rows.shift().split(",").map((h) => h.trim().toLowerCase());
const col = (name) => header.indexOf(name);
if (col("full_name") < 0 || col("email") < 0) { console.error("✗ The CSV needs at least full_name and email columns."); process.exit(1); }
const people = rows.map((line) => {
  const c = line.split(",").map((x) => x.trim());
  const role = (c[col("role")] || "consultant").toLowerCase();
  return {
    fullName: c[col("full_name")],
    email: (c[col("email")] || "").toLowerCase(),
    cell: col("cell") >= 0 ? (c[col("cell")] || "").replace(/\D/g, "") : "",
    role: role === "admin" ? "admin" : "consultant",
  };
}).filter((p) => p.fullName && p.email.includes("@"));
if (!people.length) { console.error("✗ No usable rows in the CSV."); process.exit(1); }
console.log(`${people.length} login(s) to set up:`);
for (const p of people) console.log(`  ${p.fullName.padEnd(22)} ${p.email.padEnd(34)} ${p.cell.padEnd(12)} ${p.role}`);

// --- keys and the administrator doing this -------------------------------------------------------
const key = await ask("\nService role key (hidden; Dashboard → Project Settings → API Keys): ", true);
if (!key) { console.error("✗ No key entered."); process.exit(1); }
const H = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
const adminEmail = (await ask("Your own register sign-in email (recorded as who created these): ")).toLowerCase();

async function listUsers() {
  const all = [];
  for (let page = 1; page <= 20; page++) {
    const r = await fetch(`${URL_BASE}/auth/v1/admin/users?page=${page}&per_page=200`, { headers: H });
    if (r.status === 401 || r.status === 403) { console.error("\n✗ The key was not accepted — is it the service role key (not the publishable one)?"); process.exit(1); }
    if (!r.ok) { console.error("\n✗ Could not list the logins: HTTP", r.status); process.exit(1); }
    const users = (await r.json()).users ?? [];
    all.push(...users);
    if (users.length < 200) break;
  }
  return all;
}
const existing = await listUsers();
const byEmail = new Map(existing.map((u) => [(u.email || "").toLowerCase(), u]));
const admin = byEmail.get(adminEmail);
if (!admin) { console.error(`\n✗ No login with the address ${adminEmail} — that must be your own register sign-in.`); process.exit(1); }

const ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const LIMIT = 256 - (256 % ALPHABET.length);
function pick() { for (;;) { const b = randomBytes(1)[0]; if (b < LIMIT) return ALPHABET[b % ALPHABET.length]; } }
const newPassword = () => Array.from({ length: 4 }, () => Array.from({ length: 4 }, pick).join("")).join("-");

async function rest(path, init) {
  const r = await fetch(`${URL_BASE}${path}`, { ...init, headers: { ...H, ...(init.headers || {}) } });
  const text = await r.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { ok: r.ok, status: r.status, json, text };
}

// --- one person at a time ----------------------------------------------------------------------
const results = [];
for (const p of people) {
  const line = { ...p, password: "", link: "", note: "" };
  try {
    let user = byEmail.get(p.email);
    if (user) {
      line.note = "login existed — password unchanged";
      if (REQUIRE_CHANGE) {
        const u = await rest(`/auth/v1/admin/users/${user.id}`, { method: "PUT", body: JSON.stringify({ user_metadata: { ...(user.user_metadata || {}), must_change_password: true } }) });
        if (!u.ok) throw new Error(`require change: HTTP ${u.status} ${u.text.slice(0, 160)}`);
        line.note = "login existed — must choose a new password at the next sign-in";
      }
    } else {
      const pw = newPassword();
      const c = await rest("/auth/v1/admin/users", { method: "POST", body: JSON.stringify({ email: p.email, password: pw, email_confirm: true, user_metadata: { full_name: p.fullName, must_change_password: true } }) });
      if (!c.ok) throw new Error(`create login: HTTP ${c.status} ${c.text.slice(0, 160)}`);
      user = c.json; line.password = pw; byEmail.set(p.email, user);
    }
    // role + personal link (the function makes the link code)
    const m = await rest("/rest/v1/rpc/upsert_staff_member", { method: "POST", body: JSON.stringify({ p_user: user.id, p_role: p.role, p_active: true, p_by: admin.id }) });
    if (!m.ok) throw new Error(`role: HTTP ${m.status} ${m.text.slice(0, 160)}`);
    const code = m.json?.link_code;
    line.link = code ? `${SITE}/index.html?c=${code}` : "(no link code?)";
    // details, as "My details" would save them
    const d = await rest("/rest/v1/staff_profiles", {
      method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ user_id: user.id, full_name: p.fullName, email: p.email, cell: p.cell || null, updated_at: new Date().toISOString() }),
    });
    if (!d.ok) throw new Error(`details: HTTP ${d.status} ${d.text.slice(0, 160)}`);
  } catch (e) {
    line.note = `✗ ${e.message}`;
  }
  results.push(line);
}

// --- the sheet to read out by phone ------------------------------------------------------------
console.log("\nDone. Each password is one-time (the register makes them choose their own at sign-in), so it may go by email with the link.\n");
for (const r of results) {
  console.log(`${r.fullName} — ${r.email}`);
  console.log(`   link:      ${r.link}`);
  if (r.password) console.log(`   password:  ${r.password}`);
  if (r.note) console.log(`   note:      ${r.note}`);
  console.log("");
}
console.log("Close this terminal window afterwards so the passwords are not left on screen.");
