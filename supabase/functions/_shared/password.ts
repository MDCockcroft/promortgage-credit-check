// One-time passwords an administrator issues from the Staff screen (create a login, or let someone
// back in). Same shape as scripts/create-logins.mjs: four groups of four from an alphabet without
// look-alikes, joined by hyphens — always 12+ characters with a small letter, a capital, a digit
// and a symbol, which is what Supabase Auth requires here. Pure — tested in password_test.ts.

const ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const LIMIT = 256 - (256 % ALPHABET.length); // rejection sampling: no modulo bias

function pick(): string {
  const b = new Uint8Array(1);
  for (;;) {
    crypto.getRandomValues(b);
    if (b[0] < LIMIT) return ALPHABET[b[0] % ALPHABET.length];
  }
}

export function oneTimePassword(): string {
  for (;;) {
    const p = Array.from({ length: 4 }, () => Array.from({ length: 4 }, pick).join("")).join("-");
    if (/[a-z]/.test(p) && /[A-Z]/.test(p) && /[0-9]/.test(p)) return p;
  }
}

/** What an administrator types for a new person. Returns the cleaned values, or the field at fault. */
export function newLoginInput(
  body: { fullName?: unknown; email?: unknown; cell?: unknown; role?: unknown },
): { ok: true; fullName: string; email: string; cell: string | null; role: "admin" | "consultant" } | { ok: false; field: string } {
  const fullName = typeof body.fullName === "string" ? body.fullName.trim().replace(/\s+/g, " ") : "";
  if (fullName.length < 2 || fullName.length > 80 || /[<>\u0000-\u001f]/.test(fullName)) return { ok: false, field: "fullName" };
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (email.length > 254 || !/^[^\s@<>"',;]+@[^\s@<>"',;]+\.[a-z]{2,}$/.test(email)) return { ok: false, field: "email" };
  let cell: string | null = null;
  if (body.cell != null && body.cell !== "") {
    if (typeof body.cell !== "string") return { ok: false, field: "cell" };
    let d = body.cell.replace(/[\s()-]/g, "");
    if (/^\+27\d{9}$/.test(d)) d = "0" + d.slice(3);
    if (!/^0\d{9}$/.test(d)) return { ok: false, field: "cell" };
    cell = d;
  }
  if (body.role !== "admin" && body.role !== "consultant") return { ok: false, field: "role" };
  return { ok: true, fullName, email, cell, role: body.role };
}
