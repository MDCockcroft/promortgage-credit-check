#!/usr/bin/env node
// Set a new password for a staff login (Supabase Auth admin API). For when someone has lost theirs:
// the register has no "forgot password" page yet, so a recovery email would lead nowhere.
// The service-role key is typed HERE in your terminal (hidden) and used for two calls — it is never
// printed, logged or saved. The new password is generated, shown ONCE for you to pass on by phone,
// and stored nowhere else. The person signs in with it as they did before.
//
//   node scripts/reset-password.mjs liz@example.com
import readline from "node:readline";
import { randomBytes } from "node:crypto";

const URL_BASE = "https://mxakigcvckhmyppoiuds.supabase.co";
const email = (process.argv[2] || "").trim().toLowerCase();
if (!email.includes("@")) { console.error("usage: node scripts/reset-password.mjs <staff email>"); process.exit(1); }

function ask(q, hidden = false) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) rl._writeToOutput = (s) => { if (!s.startsWith(q)) rl.output.write(s.includes("\n") ? "\n" : ""); else rl.output.write(q); };
    rl.question(q, (a) => { rl.close(); resolve(a.trim()); });
  });
}

const key = await ask("Service role key (hidden; Dashboard → Project Settings → API Keys): ", true);
if (!key) { console.error("✗ No key entered."); process.exit(1); }
const H = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };

// Find the login by address (the admin list is paged).
let user = null;
for (let page = 1; page <= 20 && !user; page++) {
  const r = await fetch(`${URL_BASE}/auth/v1/admin/users?page=${page}&per_page=200`, { headers: H });
  if (r.status === 401 || r.status === 403) { console.error("\n✗ The key was not accepted — is it the service role key (not the publishable one)?"); process.exit(1); }
  if (!r.ok) { console.error("\n✗ Could not list the logins: HTTP", r.status); process.exit(1); }
  const users = (await r.json()).users ?? [];
  user = users.find((u) => (u.email || "").toLowerCase() === email) ?? null;
  if (users.length < 200) break;
}
if (!user) { console.error(`\n✗ No login with the address ${email}.`); process.exit(1); }

// A password that is easy to read out over the phone: four groups of four from an alphabet without
// look-alikes (no 0/O, 1/l/I). 16 characters from 55 — far beyond anything guessable.
const ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const LIMIT = 256 - (256 % ALPHABET.length); // rejection sampling: no modulo bias
function pick() { for (;;) { const b = randomBytes(1)[0]; if (b < LIMIT) return ALPHABET[b % ALPHABET.length]; } }
const password = Array.from({ length: 4 }, () => Array.from({ length: 4 }, pick).join("")).join("-");

const r = await fetch(`${URL_BASE}/auth/v1/admin/users/${user.id}`, { method: "PUT", headers: H, body: JSON.stringify({ password }) });
if (!r.ok) { console.error("\n✗ The reset failed: HTTP", r.status, (await r.text()).slice(0, 200)); process.exit(1); }
console.log(`\n✓ New password set for ${email}. Read it out by phone (not email or WhatsApp), then have them sign in once:\n\n    ${password}\n`);
console.log("Close this terminal window afterwards so the password is not left on screen.");
