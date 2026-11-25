// Email notifications to the person an application belongs to (client feedback, 18 Nov 2026), as pure
// functions so mm-maintenance stays thin and the rules are tested without a database or a mail service:
//   - one email when an application the client finished is READY for its credit check;
//   - one email when it NEEDS ATTENTION because of something on the client's side;
//   - never for something staff did themselves (they are looking at the record already);
//   - "ready" goes at once (the next run); "needs attention" only after the record has sat in that
//     state for 5 minutes, because a client who fails the identity questions may start a second round
//     straight away (from then the record is idv_in_progress and the clock is dropped) (the form uploads the ID copy BEFORE the questions, so a missing copy is real);
//   - once per application per kind, ever (notification_log, migration 20261011).
// The email carries the reference and a link only — never the client's name or ID number.

import { allowedFrom, type IdvMode } from "./states.ts";

export type Kind = "ready" | "attention";

/** How long a record must stay in a state before its email goes (the job runs every minute). */
export const SETTLE_MS: Record<Kind, number> = { ready: 0, attention: 5 * 60 * 1000 };
/** Emails per run: a backlog drains over the next runs instead of bursting. */
export const MAX_PER_RUN = 20;

export interface Candidate {
  ref: string;
  status: string;
  has_id_copy: boolean;
  id_copy_source: string | null; // 'client' | 'staff' | null
  recipient_ids: string[] | null;
  recipient_emails: string[] | null;
  log: { kind: Kind; first_seen_at: string; sent_at: string | null }[] | null;
}
export interface Pending { ref: string; kind: Kind }
export interface Send { ref: string; kind: Kind; reason: string; next: string; ids: string[]; emails: string[] }

/** Why a client-side stop needs staff, and what to do about it: two plain sentences (the email's body). */
const ATTENTION: Record<string, { reason: string; next: string }> = {
  idv_failed: { reason: "The client did not pass the identity questions.", next: "Open the application to verify their identity by hand, or send them a new link." },
  idv_unavailable: { reason: "The identity questions could not be asked.", next: "Open the application to verify the client's identity by hand." },
  manual_required: { reason: "The client's identity has to be verified by hand.", next: "Open the application to verify the client's identity." },
  config_error: { reason: "A system issue stopped this application.", next: "Open the application to see what happened." },
};
export const NO_ID_REASON = "The client's ID copy is not on the record.";
const NO_ID_NEXT = "Attach the ID copy to the application, then run the credit check.";
export const READY_REASON = "The client has finished. The credit check can be run.";
const READY_NEXT = "Open the application and run the credit check.";

/**
 * Which email (if any) this record calls for now. Mirrors the dashboard's buckets (assets/store.js
 * bucketOf + admin.html needsIdCopy) minus everything staff cause themselves: a failed credit check,
 * a manual verification, an ID copy staff attached.
 */
export function notifyKind(c: Pick<Candidate, "status" | "has_id_copy" | "id_copy_source">, mode: IdvMode): { kind: Kind; reason: string; next: string } | null {
  const stop = ATTENTION[c.status];
  if (stop) return { kind: "attention", ...stop };
  const runnable = allowedFrom(mode).filter((s) => s !== "check_failed");
  if (!runnable.includes(c.status)) return null;
  if (!c.has_id_copy) return { kind: "attention", reason: NO_ID_REASON, next: NO_ID_NEXT };
  if (c.status === "manual_verified" || c.id_copy_source === "staff") return null; // staff did the last step
  return { kind: "ready", reason: READY_REASON, next: READY_NEXT };
}

/**
 * One run's work. `start`: begin the settle clock. `drop`: a clock whose record has moved on.
 * `send`: settled and unsent, oldest first, capped. `noRecipient`: nobody usable to tell (logged).
 */
export function plan(cands: Candidate[], pending: Pending[], mode: IdvMode, now: Date): {
  start: Pending[]; drop: Pending[]; send: Send[]; noRecipient: string[];
} {
  const current = new Map<string, string>(); // ref → kind it calls for now
  const start: Pending[] = [], noRecipient: string[] = [];
  const due: (Send & { since: number })[] = [];
  for (const c of cands) {
    const want = notifyKind(c, mode);
    if (!want) continue;
    current.set(c.ref, want.kind);
    const entry = (c.log ?? []).find((l) => l.kind === want.kind);
    if (!entry) { start.push({ ref: c.ref, kind: want.kind }); continue; }
    if (entry.sent_at) continue;
    const since = new Date(entry.first_seen_at).getTime();
    if (!Number.isFinite(since) || now.getTime() - since < SETTLE_MS[want.kind]) continue;
    const emails = (c.recipient_emails ?? []).filter((e) => typeof e === "string" && e.includes("@"));
    if (!emails.length) { noRecipient.push(c.ref); continue; }
    due.push({ ref: c.ref, kind: want.kind, reason: want.reason, next: want.next, ids: c.recipient_ids ?? [], emails, since });
  }
  const drop = pending.filter((p) => current.get(p.ref) !== p.kind);
  due.sort((a, b) => a.since - b.since);
  const send = due.slice(0, MAX_PER_RUN).map(({ since: _since, ...s }) => s);
  return { start, drop, send, noRecipient };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]!));

/** The pages' own colours (assets/styles.css), fixed here because an email cannot read a stylesheet. */
const INK = "#1a1a1a", MUTED = "#64748b", RAIL = "#141414", GOLD = "#d6ad3d", HAIRLINE = "#e5e5e5", SUNKEN = "#f5f5f5";
const TAG: Record<Kind, { label: string; ink: string; tint: string }> = {
  ready: { label: "Ready to run", ink: "#1d6b43", tint: "#e9f3ed" },
  attention: { label: "Needs attention", ink: "#77600e", tint: "#faf3de" },
};
const FONT = "Arial,Helvetica,sans-serif";
const MONO = "'SF Mono',Menlo,Consolas,'Courier New',monospace";

/**
 * The email itself: the black band with the logo, the status, the reference, two sentences and one
 * button. Tables and inline styles only (Outlook); it reads the same with images switched off, where
 * the logo's alt text shows in gold on the band. Never the client's name or ID number.
 */
export function emailFor(s: Pick<Send, "ref" | "kind" | "reason"> & { next?: string }, dashboardUrl: string): { subject: string; text: string; html: string } {
  // Michael's wording (25 Nov 2026): the same subject for every application, the reference in the body only.
  const subject = s.kind === "ready" ? "Credit Check Ready To Run" : "Credit Check Requires Attention";
  const tag = TAG[s.kind];
  const text = [
    `${tag.label}: application ${s.ref}`,
    "",
    s.reason,
    ...(s.next ? [s.next] : []),
    "",
    `Open the dashboard: ${dashboardUrl}`,
    "",
    "Pro Mortgage credit check. This is an automatic message; replies are not read.",
  ].join("\n");
  // The logo sits beside the dashboard page. A dashboard address that is not a full URL must never stop an email.
  let logo = "https://check.promortgagesa.co.za/assets/logo.png";
  try { logo = new URL("assets/logo.png", dashboardUrl).href; } catch { /* keep the live one */ }
  const html = [
    `<div style="margin:0;padding:24px 12px;background:${SUNKEN}">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid ${HAIRLINE};font-family:${FONT};color:${INK}">`,
    `<tr><td align="center" style="background:${RAIL};padding:22px 24px 18px;border-bottom:3px solid ${GOLD}">`,
    `<img src="${esc(logo)}" width="132" height="97" alt="PRO MORTGAGE" style="display:block;border:0;width:132px;height:auto;font-family:${FONT};font-size:18px;font-weight:bold;letter-spacing:2px;color:${GOLD}">`,
    `</td></tr>`,
    `<tr><td style="padding:32px 32px 8px">`,
    `<span style="display:inline-block;padding:5px 12px;border-radius:999px;background:${tag.tint};color:${tag.ink};font-size:12px;font-weight:bold;letter-spacing:1px;text-transform:uppercase">${tag.label}</span>`,
    `<p style="margin:20px 0 4px;font-size:12px;letter-spacing:1.5px;text-transform:uppercase;color:${MUTED}">Application</p>`,
    `<p style="margin:0 0 20px;font-family:${MONO};font-size:28px;line-height:1.2;font-weight:bold;color:${INK}">${esc(s.ref)}</p>`,
    `<p style="margin:0 0 6px;font-size:16px;line-height:1.5;color:${INK}">${esc(s.reason)}</p>`,
    s.next ? `<p style="margin:0;font-size:15px;line-height:1.5;color:${MUTED}">${esc(s.next)}</p>` : "",
    `</td></tr>`,
    `<tr><td style="padding:24px 32px 32px">`,
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="background:${RAIL};border-radius:4px">`,
    `<a href="${esc(dashboardUrl)}" style="display:inline-block;padding:14px 28px;font-family:${FONT};font-size:15px;font-weight:bold;color:#ffffff;text-decoration:none">Open the dashboard</a>`,
    `</td></tr></table>`,
    `</td></tr>`,
    `<tr><td style="padding:16px 32px;border-top:1px solid ${HAIRLINE};font-size:12px;line-height:1.5;color:${MUTED}">Pro Mortgage credit check. This is an automatic message; replies are not read.</td></tr>`,
    `</table>`,
    `</div>`,
  ].join("");
  return { subject, text, html };
}
