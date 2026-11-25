import { assert, assertEquals } from "jsr:@std/assert@1";
import { type Candidate, emailFor, MAX_PER_RUN, NO_ID_REASON, notifyKind, PASSPORT, plan, SETTLE_MS } from "./notify.ts";

const NOW = new Date("2026-11-18T10:00:00Z");
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString();
const cand = (over: Partial<Candidate>): Candidate => ({
  ref: "PM-A1", status: "idv_passed", has_id_copy: true, id_copy_source: "client",
  recipient_ids: ["u1"], recipient_emails: ["owner@test"], log: [], ...over,
});

Deno.test("ready: the client finished by themselves, with an ID copy", () => {
  assertEquals(notifyKind(cand({}), "required")?.kind, "ready");
  // identity questions switched off: a registered consent is runnable
  assertEquals(notifyKind(cand({ status: "consent_registered" }), "off")?.kind, "ready");
  // ...but while they are required it is still waiting on the client
  assertEquals(notifyKind(cand({ status: "consent_registered" }), "required"), null);
});

Deno.test("needs attention: client-side stops and a missing ID copy", () => {
  for (const status of ["idv_failed", "idv_unavailable", "manual_required", "config_error"]) {
    assertEquals(notifyKind(cand({ status }), "required")?.kind, "attention", status);
  }
  const noId = notifyKind(cand({ has_id_copy: false, id_copy_source: null }), "required");
  assertEquals([noId?.kind, noId?.reason], ["attention", NO_ID_REASON]);
});

Deno.test("a passport application is announced in its own words, not as a failed identity check", () => {
  const p = notifyKind(cand({ status: "manual_required", id_type: "passport" }), "required");
  assertEquals([p?.kind, p?.reason, p?.tag], ["attention", PASSPORT.reason, "passport"]);
  const mail = emailFor({ ref: "PM-PP1", ...p! }, "https://check.promortgagesa.co.za/admin.html");
  assertEquals(mail.subject, "Passport Application Received");
  assert(mail.html.includes("Passport application") && !mail.html.includes("Needs attention"));
  // the tag survives the plan, so the sender uses it
  const sent = plan([cand({ status: "manual_required", id_type: "passport", log: [{ kind: "attention", first_seen_at: ago(6), sent_at: null }] })], [], "required", NOW).send;
  assertEquals(sent.map((x) => x.tag), ["passport"]);
  // an SA ID that needs manual handling keeps the usual wording
  assert(notifyKind(cand({ status: "manual_required", id_type: "said" }), "required")?.reason !== PASSPORT.reason);
});

Deno.test("nothing for what staff did themselves, or for states that need nobody", () => {
  assertEquals(notifyKind(cand({ status: "manual_verified" }), "required"), null);          // staff verified
  assertEquals(notifyKind(cand({ id_copy_source: "staff" }), "required"), null);            // staff attached the ID
  for (const status of ["check_failed", "check_in_flight", "report_ready", "idv_in_progress", "consent_confirmed",
    "consent_withdrawn", "expired", "report_requested"]) {
    assertEquals(notifyKind(cand({ status }), "required"), null, status);
  }
});

Deno.test("plan: ready goes on the run after it is first seen, once", () => {
  // first sight: note it, send nothing
  let p = plan([cand({})], [], "required", NOW);
  assertEquals([p.start, p.send.length], [[{ ref: "PM-A1", kind: "ready" }], 0]);
  // the next run (a minute later): send to the owner
  p = plan([cand({ log: [{ kind: "ready", first_seen_at: ago(1), sent_at: null }] })], [{ ref: "PM-A1", kind: "ready" }], "required", NOW);
  assertEquals(p.send.map((s) => [s.ref, s.kind, s.emails]), [["PM-A1", "ready", ["owner@test"]]]);
  // already sent: never again
  p = plan([cand({ log: [{ kind: "ready", first_seen_at: ago(60), sent_at: ago(50) }] })], [], "required", NOW);
  assertEquals([p.start.length, p.send.length], [0, 0]);
});

Deno.test("plan: needs attention waits 5 minutes, so a second try at the questions cancels it", () => {
  assertEquals([SETTLE_MS.ready, SETTLE_MS.attention], [0, 300_000]);
  const failed = (min: number) => cand({ status: "idv_failed", log: [{ kind: "attention", first_seen_at: ago(min), sent_at: null }] });
  const clock = [{ ref: "PM-A1", kind: "attention" as const }];
  assertEquals(plan([failed(4)], clock, "required", NOW).send.length, 0);   // still waiting
  assertEquals(plan([failed(5)], clock, "required", NOW).send.map((s) => s.kind), ["attention"]);
  // failed at minute 0, passed on the second try at minute 3: the attention clock is dropped unsent
  const p = plan([cand({ log: [{ kind: "attention", first_seen_at: ago(3), sent_at: null }] })], clock, "required", NOW);
  assertEquals([p.drop, p.start, p.send.length], [clock, [{ ref: "PM-A1", kind: "ready" }], 0]);
});

Deno.test("plan: a clock whose record has moved on (or gone) is dropped", () => {
  const p = plan([cand({ ref: "PM-B2", status: "report_ready" })], [{ ref: "PM-B2", kind: "ready" }, { ref: "PM-GONE", kind: "attention" }], "required", NOW);
  assertEquals(p.drop.length, 2);
});

Deno.test("plan: attention after ready is its own email; nobody to tell is reported, not sent", () => {
  const settled = [{ kind: "attention" as const, first_seen_at: ago(30), sent_at: null }];
  let p = plan([cand({ status: "idv_failed", log: [{ kind: "ready", first_seen_at: ago(90), sent_at: ago(80) }, ...settled] })], [], "required", NOW);
  assertEquals(p.send.map((s) => s.kind), ["attention"]);
  p = plan([cand({ status: "idv_failed", recipient_ids: null, recipient_emails: null, log: settled })], [], "required", NOW);
  assertEquals([p.send.length, p.noRecipient], [0, ["PM-A1"]]);
});

Deno.test("plan: a backlog is capped per run, oldest first", () => {
  const many = Array.from({ length: MAX_PER_RUN + 5 }, (_, i) =>
    cand({ ref: `PM-${i}`, log: [{ kind: "ready", first_seen_at: ago(20 + i), sent_at: null }] }));
  const p = plan(many, [], "required", NOW);
  assertEquals(p.send.length, MAX_PER_RUN);
  assertEquals(p.send[0].ref, `PM-${MAX_PER_RUN + 4}`); // the longest-waiting one
});

Deno.test("the email carries the reference and a link, and nothing about the person", () => {
  const e = emailFor({ ref: "PM-7K2Q", kind: "ready", reason: "The client has finished. The credit check can be run." }, "https://check.promortgagesa.co.za/admin.html");
  assertEquals(e.subject, "Credit Check Ready To Run");
  assert(e.text.includes("PM-7K2Q") && e.text.includes("https://check.promortgagesa.co.za/admin.html"));
  assert(e.html.includes('href="https://check.promortgagesa.co.za/admin.html"'));
  // the brand band: the logo beside the dashboard page, with the name behind it for when images are off
  assert(e.html.includes('src="https://check.promortgagesa.co.za/assets/logo.png"') && e.html.includes('alt="PRO MORTGAGE"'));
  assert(e.html.includes("Ready to run") && e.text.startsWith("Ready to run: application PM-7K2Q"));
  // the next step, when given, is in both parts
  const withNext = emailFor({ ref: "PM-1", kind: "attention", reason: "r", next: "Do this next." }, "https://x.test/admin.html");
  assert(withNext.html.includes("Do this next.") && withNext.text.includes("Do this next.") && withNext.html.includes("Needs attention"));
  assertEquals(emailFor({ ref: "PM-7K2Q", kind: "attention", reason: "x" }, "u").subject, "Credit Check Requires Attention");
  // a reason is escaped in the HTML part
  assert(emailFor({ ref: "PM-1", kind: "attention", reason: "The client's <ID>" }, "u").html.includes("client&#39;s &lt;ID&gt;"));
});
