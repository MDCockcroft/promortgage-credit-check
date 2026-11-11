#!/usr/bin/env node
// Set a new password for a staff login (Supabase Auth admin API). For when someone has lost theirs:
// the register has no "forgot password" page yet, so a recovery email would lead nowhere.
// The service-role key is typed HERE in your terminal (hidden) and used for two calls — it is never
// printed, logged or saved. The new password is generated, shown ONCE for you to pass on by phone,
// and stored nowhere else. It is ONE-TIME: at the next sign-in the register makes the person choose
// their own password before it shows anything (must_change_password on the login).
//
//   node scripts/reset-password.mjs liz@example.com [another@example.com ...]
import readline from "node:readline";
import { randomBytes } from "node:crypto";

const URL_BASE = "https://mxakigcvckhmyppoiuds.supabase.co";
const emails = [...new Set(process.argv.slice(2).map((e) => e.trim().toLowerCase()).filter(Boolean))];
if (!emails.length || emails.some((e) => !e.includes("@"))) { console.error("usage: node scripts/reset-password.mjs <staff email> [more emails ...]"); process.exit(1); }

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

// Every login, by address (the admin list is paged).
const byEmail = new Map();
for (let page = 1; page <= 20; page++) {
  const r = await fetch(`${URL_BASE}/auth/v1/admin/users?page=${page}&per_page=200`, { headers: H });
  if (r.status === 401 || r.status === 403) { console.error("\n✗ The key was not accepted — is it the service role key (not the publishable one)?"); process.exit(1); }
  if (!r.ok) { console.error("\n✗ Could not list the logins: HTTP", r.status); process.exit(1); }
  const users = (await r.json()).users ?? [];
  for (const u of users) byEmail.set((u.email || "").toLowerCase(), u);
  if (users.length < 200) break;
}

// A password that is easy to type: four groups of four from an alphabet without look-alikes
// (no 0/O, 1/l/I), always with a small letter, a capital and a digit; the dashes are the symbol.
const ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const LIMIT = 256 - (256 % ALPHABET.length); // rejection sampling: no modulo bias
function pick() { for (;;) { const b = randomBytes(1)[0]; if (b < LIMIT) return ALPHABET[b % ALPHABET.length]; } }
function newPassword() { for (;;) { const p = Array.from({ length: 4 }, () => Array.from({ length: 4 }, pick).join("")).join("-"); if (/[a-z]/.test(p) && /[A-Z]/.test(p) && /[0-9]/.test(p)) return p; } }

console.log("\nEach password is one-time: the register makes the person choose their own at sign-in, so it may go by email.\n");
for (const email of emails) {
  const user = byEmail.get(email);
  if (!user) { console.log(`${email}\n   ✗ no login with this address\n`); continue; }
  const password = newPassword();
  const r = await fetch(`${URL_BASE}/auth/v1/admin/users/${user.id}`, { method: "PUT", headers: H, body: JSON.stringify({ password, user_metadata: { ...(user.user_metadata || {}), must_change_password: true } }) });
  if (!r.ok) { console.log(`${email}\n   ✗ the reset failed: HTTP ${r.status} ${(await r.text()).slice(0, 200)}\n`); continue; }
  console.log(`${email}\n   password:  ${password}\n`);
}
console.log("Close this terminal window afterwards so the passwords are not left on screen.");
