# Demo runbook — end-to-end demo for Pro Mortgages SA and MortgageMAX (video call)

Purpose: show both parties the live system in MortgageMAX's **UAT** environment, end to end, so that
MortgageMAX gives the written acceptance of UAT testing (Addendum clause 4) and the production
details, and Pro Mortgages SA sees what its consultants will use. About 30 minutes of demo, plus
questions. Live status: `HANDOVER-2026-09-26.md`. Go-live procedure afterwards: `GO-LIVE-RUNBOOK.md`.

## The day before

- [ ] **Switch the live site to UAT-live** (real UAT consent, questions and report, no SMS, nothing
      billed): `supabase secrets set MM_MODE=live --project-ref mxakigcvckhmyppoiuds` (MMAX_ENV stays
      `uat`). Then one read-only check with Claude: the form loads the consent wording from UAT.
- [ ] **Pick the test identities** (Bennie's test IDs, client folder — never in this repo or on
      screen longer than needed). MortgageMAX allows **two question rounds per ID number per 24 hours**
      across all its systems: rehearsal and demo must use **different** IDs, or rehearse the day
      before. Keep one spare ID for the demo.
- [ ] **Rehearse once** through your own link with a rehearsal ID: submit → consent → questions →
      run check → report + PDF. Then delete the record. Note how long the questions and the check take.
- [ ] **One consultant login** (a real consultant's, or a demo one you delete afterwards) with role
      Consultant and their details added, so the consultant view can be shown live. Administrator
      view = your own login.
- [ ] **Two browser windows ready**: window A signed in as the consultant (the register), window B
      the client form opened through that consultant's link, blank. Phone nearby, signed in as the
      consultant, for the camera step (or a prepared photo file on the Mac as the fallback).
- [ ] **Specimen files** on the Mac for the override: the blank MortgageMAX form (downloadable from
      the panel) and a photo file (JPG or PNG).
- [ ] **Fallback**: if UAT misbehaves on the day (the credit API was down for an hour on 30 Sep),
      switch back to `MM_MODE=mock` and continue — same screens, sample answers and a sample report.
      Say so plainly.

## The storyline (window B = client, window A = consultant, admin = your login)

1. **Frame it (2 min).** Pro Mortgages SA's own site at `check.promortgagesa.co.za`; MortgageMAX's
   UAT behind it; nothing here is production or billed; test identities only.
2. **The consultant's link (A).** Sign-in page; the register; "Your personal link". Every application
   comes through a consultant's link, straight to that consultant. The bare address opens nothing.
3. **The client applies (B).** Open the link: "Your consultant: <name>". Walk the form: particulars,
   address, employment, income; the Pro Mortgage notice; the MortgageMAX consent, loaded live from
   UAT, exactly as MortgageMAX publishes it. Submit → "Registering your consent" → the identity
   questions appear. Point out: no SMS code; consent is registered at MortgageMAX before any question
   is asked; MortgageMAX can see the consent in its own UAT register.
4. **Pass the questions (B)** with the test identity's answers → "Your identity has been verified".
   (The page never stores the answers.)
5. **The consultant runs the check (A).** The record shows "Identity verified. Ready to run the
   credit check." Run it → under a minute → score, flags, standing, decline reasons, affordability;
   "Open credit report (PDF)" = the bureau's own document. "Download the client's application form
   (PDF)" = what the client completed, with the consent they accepted.
6. **The override path (B then A).** A second application with another test ID; answer wrongly →
   "Identity check failed". In A: the plain status says what to do; attach the client's ID copy in
   the "Client's ID copy" section (every record needs one before a check); "Verify identity manually":
   download the blank MortgageMAX form, upload a signed specimen, tick the confirmation under the two
   statements, save → "Verified manually", the evidence block (who, when, the signed form, both
   statements). Then run the check as before.
7. **What the administrator sees (admin).** The same record: the consent audit trail, MortgageMAX's
   read-back, consent events, the identity result codes, the raw report data, the access log (every
   view of a report or evidence file is logged with who and when). Staff screen: roles, who owns what.
8. **Close (A).** Record withdrawal on a test record: withdrawn here and at MortgageMAX; no check can
   run on it. Delete the test records (administrator).

## What to say about what is in place

- **Consent**: the client accepts the Pro Mortgage notice and MortgageMAX's own consent wording
  (Broad consent, version and fingerprint recorded); registered with MortgageMAX before any identity
  question; withdrawal honoured locally first and sent to MortgageMAX; the application PDF is the
  client's completed form as evidence.
- **Identity**: MortgageMAX's knowledge-based questions, pass mark 60 (MortgageMAX's own practice),
  two rounds per application and per ID number per day; the only alternative is the manual override
  with the signed form and the consultant's confirmations (the verbatim Experian statement and the
  identity confirmation), kept as audit evidence. A copy of the client's ID is attached to every
  record and no check runs without it. Passports: no credit check (Experian covers SA IDs only).
- **Access**: every consultant sees only their own clients; administrators see everything; only
  administrators delete; every report view, PDF open and evidence file open is logged.
- **Abuse limits**: applications only through an active consultant's link; 5 per person per link,
  30 per link, 300 in all per day; the vendor's question limits on top.
- **Data**: Supabase (Pro organisation, backed up daily, hosted in the EU, which the consent covers);
  identity answers never stored; credit report and PDF stored only for the record's life; delete
  destroys everything including evidence files (administrators only, warned first).
- **Emergency stop**: one switch stops every call to MortgageMAX and every new application in
  production, without a deploy.
- **Still to do before production** (say it): MortgageMAX's written UAT acceptance and production
  details; Pro Mortgages SA's legal review and Operator Agreement; the consultant logins.

## Leave-behind

One page for the attendees, "Pro Mortgages SA credit check: what is in place" (shared doc):
https://claude.ai/artifact/39b1a2Sh8yS8mu2qsbNW4d — the flow, the controls table, and what each party still
provides. Share the link after the call, or export it to PDF from the doc.

## After the demo

- [ ] `supabase secrets set MM_MODE=mock --project-ref mxakigcvckhmyppoiuds` — back to mock until go-live.
- [ ] Delete every demo record (administrator), and the demo consultant login if you made one.
- [ ] Ask MortgageMAX, in writing, for the UAT acceptance and the production details
      (`vendor-email-2026-10-15-bennie-production-details-DRAFT.md`).
- [ ] Then `GO-LIVE-RUNBOOK.md`.
