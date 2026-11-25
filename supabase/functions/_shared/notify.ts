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
export interface Send { ref: string; kind: Kind; reason: string; ids: string[]; emails: string[] }

/** Why a client-side stop needs staff, in one plain sentence (also the email's body line). */
const ATTENTION_REASON: Record<string, string> = {
  idv_failed: "The client did not pass the identity questions.",
  idv_unavailable: "The identity questions could not be asked.",
  manual_required: "The client's identity has to be verified by hand.",
  config_error: "A system issue stopped this application.",
};
export const NO_ID_REASON = "The client's ID copy is not on the record.";
export const READY_REASON = "The client has finished. The credit check can be run.";

/**
 * Which email (if any) this record calls for now. Mirrors the dashboard's buckets (assets/store.js
 * bucketOf + admin.html needsIdCopy) minus everything staff cause themselves: a failed credit check,
 * a manual verification, an ID copy staff attached.
 */
export function notifyKind(c: Pick<Candidate, "status" | "has_id_copy" | "id_copy_source">, mode: IdvMode): { kind: Kind; reason: string } | null {
  const stop = ATTENTION_REASON[c.status];
  if (stop) return { kind: "attention", reason: stop };
  const runnable = allowedFrom(mode).filter((s) => s !== "check_failed");
  if (!runnable.includes(c.status)) return null;
  if (!c.has_id_copy) return { kind: "attention", reason: NO_ID_REASON };
  if (c.status === "manual_verified" || c.id_copy_source === "staff") return null; // staff did the last step
  return { kind: "ready", reason: READY_REASON };
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
    due.push({ ref: c.ref, kind: want.kind, reason: want.reason, ids: c.recipient_ids ?? [], emails, since });
  }
  const drop = pending.filter((p) => current.get(p.ref) !== p.kind);
  due.sort((a, b) => a.since - b.since);
  const send = due.slice(0, MAX_PER_RUN).map(({ since: _since, ...s }) => s);
  return { start, drop, send, noRecipient };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]!));

/** The email itself. Reference, one sentence, one link. */
export function emailFor(s: Pick<Send, "ref" | "kind" | "reason">, dashboardUrl: string): { subject: string; text: string; html: string } {
  const subject = s.kind === "ready" ? `${s.ref} is ready for its credit check` : `${s.ref} needs your attention`;
  const text = [
    `Application ${s.ref}`,
    "",
    s.reason,
    "",
    `Open the dashboard: ${dashboardUrl}`,
    "",
    "Pro Mortgage credit check. This is an automatic message; replies are not read.",
  ].join("\n");
  const html = [
    `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1a1a1a">`,
    `<p style="margin:0 0 12px"><strong>Application ${esc(s.ref)}</strong></p>`,
    `<p style="margin:0 0 16px">${esc(s.reason)}</p>`,
    `<p style="margin:0 0 24px"><a href="${esc(dashboardUrl)}">Open the dashboard</a></p>`,
    `<p style="margin:0;font-size:12px;color:#666">Pro Mortgage credit check. This is an automatic message; replies are not read.</p>`,
    `</div>`,
  ].join("");
  return { subject, text, html };
}
