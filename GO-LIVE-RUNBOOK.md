# Go-live runbook — switching the credit check to production

The system is ready for production except for what other people hold: MortgageMAX's production
details, the SMS account, and the legal sign-off. This runbook turns go-live day into a checked
sequence: SMS first, then a free read-only test of the production details, then one real check on a
consenting person, then the consultants. Plan about an hour with both of us. Live status stays in
`HANDOVER-2026-09-26.md`; this file is the procedure.

**Rules for the day**
- Change one thing at a time and check it before the next. Every step below says what "worked" looks like.
- Function deploys are Michael's (`--workdir /Users/michaelcockcroft/promortgage-credit-check`).
- Settings files are loaded **whole**: `secrets set --env-file` overwrites every key in the file,
  including the mode switches. Before loading, read the file's `MM_MODE`, `MM_IDV_MODE`, `MMAX_ENV` and
  `SMS_MODE` lines aloud; after loading, compare digests (`supabase secrets list`).
- A single value goes in with `supabase secrets set KEY=value --project-ref mxakigcvckhmyppoiuds`.
- Keys and secrets never go in chat, this repo, or the vault.

**Emergency stop** (no deploy needed, takes effect at once):
`supabase secrets set MM_MODE=mock --project-ref mxakigcvckhmyppoiuds` — no more calls to MortgageMAX.
To stop the form accepting applications as well, also set `SMS_MODE=test`: with a production
`MMAX_ENV`, the form then refuses every submission until SMS is live again.

---

## 0. Before the day — all must be true

- [ ] **MortgageMAX:** written acceptance of our UAT testing (Addendum clause 4) and the production
      details: credit and consent base URLs, and a production subscription key. The Entra app
      registration is shared with UAT (tenant, client ID and client secret unchanged): confirm.
- [ ] **SMS:** SMSPortal account in Pro Mortgages SA's name; Client ID + API secret; a sending limit
      set on the API key in SMSPortal. (Step 1 can be done before the MortgageMAX details arrive.)
- [ ] **Legal:** Liz's placeholders in the form's notice filled in; the adviser's review done; the
      Operator Agreement signed; a decision on backing up ID copies (Supabase backups do not cover
      stored files).
- [ ] **People:** the real consultant logins created and given roles, each with their details added.
- [ ] **Address:** `check.promortgagesa.co.za` live (handover row 7), so clients never get a github.io link.
- [ ] **First check:** a consenting person for step 4 (Liz or Michael). It is billed and leaves an
      enquiry on their credit record.

## 1. SMS live (can run on its own, any time before step 3)

Nothing else changes: `MMAX_ENV` stays `uat` and `MM_MODE` stays `mock`, so no credit data moves.

| # | Who | Do | Worked when |
|---|---|---|---|
| 1.1 | Michael | `supabase secrets set SMSPORTAL_CLIENT_ID=… SMSPORTAL_API_SECRET=… SMS_MODE=test --project-ref …` | `secrets list` shows the three names with new digests |
| 1.2 | Claude | One form submission in mock mode (test name, Michael's own cell number) | The page says the code was sent; SMSPortal accepted the keys; no SMS arrives (test mode sends nothing) |
| 1.3 | Michael | `supabase secrets set SMS_MODE=live --project-ref …` | digest changes |
| 1.4 | Michael + Claude | One more submission with Michael's cell number | The SMS arrives; the code is **not** shown on screen; entering it confirms consent |
| 1.5 | Michael | Delete both test records (admin page) | Gone from the register |

## 2. Production details: read-only smoke test (free, changes nothing)

| # | Who | Do | Worked when |
|---|---|---|---|
| 2.1 | Michael | Create `supabase/.env.mmax.prod` (git-ignored) as a copy of `supabase/.env.mmax`, then change: `MMAX_SUBSCRIPTION_KEY`, `MMAX_CREDIT_BASE_URL`, `MMAX_CONSENT_BASE_URL` (production values), `MMAX_ENV=prod`. Add the SMS lines (`SMS_MODE=live`, `SMSPORTAL_CLIENT_ID`, `SMSPORTAL_API_SECRET`, `SMS_BRAND`, `SMS_DAILY_MAX`): the UAT file has none. **Keep `MM_MODE=mock`.** | The file holds the full intended live state, except `MM_MODE` |
| 2.2 | Claude | Run the private smoke test against it: client folder `tools/prod-smoke.ts` (read-only `GET /ConsentTypes`; its first two lines print the mode switches) | `HTTP 200`, and `PASS: every MM_CONSENT_TYPES id is an active consent type here` |
| 2.3 | — | If it says **FAIL**: production's Broad consent MM has a different ID. Put the ID it lists into `MM_CONSENT_TYPES` in the prod file and run 2.2 again. **Never** pick a "Broad consent BB" type: that is BetterBond's consent, the wrong originator. | PASS |

A `401` means the key or the token is wrong (check the Entra details still apply in production). A
`404` means a base URL is wrong. Stop and ask MortgageMAX; nothing has been switched yet.

## 3. Load production settings, still in mock mode

| # | Who | Do | Worked when |
|---|---|---|---|
| 3.1 | Michael | Read aloud the prod file's `MM_MODE=mock`, `MM_IDV_MODE=required`, `MM_IDV_PASS_SCORE=60`, `MMAX_ENV=prod`, `SMS_MODE=live` | All five as listed |
| 3.2 | Michael | `supabase secrets set --env-file supabase/.env.mmax.prod --project-ref …` | Loaded |
| 3.3 | Claude | Compare `secrets list` digests with the prod file | Every key matches; `MM_MODE` is still mock |
| 3.4 | Claude | One form submission (test name, Michael's cell number) through to the identity questions | A real SMS arrives; mock questions (still mock); no errors in the function logs |
| 3.5 | Michael | Delete that test record | Gone |

## 4. Live: the first real check, on a consenting person

| # | Who | Do | Worked when |
|---|---|---|---|
| 4.1 | Michael | `supabase secrets set MM_MODE=live --project-ref …` | Digest changes |
| 4.2 | The person | Apply through a consultant's personal link on the live address; confirm with the SMS code | Status **Consent registered**; the consent is registered at MortgageMAX production |
| 4.3 | The person | Answer the identity questions honestly | **Identity verified** (a score of 60 or more). If they fail: stop, the manual path is tested separately |
| 4.4 | Consultant | **Run credit check**, then **Fetch PDF** | **Report ready**; the summary matches the PDF |
| 4.5 | Claude | Function logs since 4.1: search `mm_client_error`, `mm_staff_error`, `config_error`, `membership_unreadable` | None |

If anything in step 4 goes wrong: emergency stop (top of this file), then diagnose. Never retry a
credit check blindly: each one is billed and leaves an enquiry.

## 5. Open to the consultants

- [ ] Liz sends each consultant their login and the **Consultant Guide** (shared doc).
- [ ] Each consultant signs in, adds their details, and copies their personal link.
- [ ] Update the handover header: live since <date>, `MM_MODE=live`, `MMAX_ENV=prod`.

## 6. The first week

- **Daily:** function logs (the four searches in 4.5); the register's **Needs attention** tile;
  SMSPortal balance and sending limit.
- **Clean-up job:** `select status, start_time from cron.job_run_details order by start_time desc limit 5;`
  shows `succeeded` every hour.
- **MortgageMAX's question limit** is global (two rounds per ID number per 24 hours, across all its
  systems). A client who reaches it goes to "Identity check unavailable"; the consultant verifies manually.
- Keep `supabase/.env.mmax.prod` as the record of the live settings; keep `supabase/.env.mmax` for UAT
  work, and never load it into the live project again.
