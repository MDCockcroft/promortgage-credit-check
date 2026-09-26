# BUILD PLAN — MortgageMax credit-check integration

**For:** Opus, executing. **Authored:** Fable, 2026-09-26, after a 22-agent adversarial
review of every prior finding plus 12 live UAT probes. **Status:** authoritative. Where
this file disagrees with `INTEGRATION-NOTES.md` or older vault entries, this file wins.

Michael's working preference: staged checkpoints. Show the diff or the file before
saving anything non-trivial, and stop on a failure to diagnose rather than retry.

---

## PROGRESS — 2026-09-26 (read this first)

**Nothing is committed or pushed.** The public site still serves the August form; all of the
work below lives in the working tree, plus two deployed Edge Functions running in **mock mode**.

| Step | State |
|---|---|
| 1 Tooling | Done — deno 2.9.7, supabase CLI 2.118 (brew); CLI logged in |
| 2 Scaffold | Done |
| 3 Migration | **Applied** to `mxakigcvckhmyppoiuds` (Pro org, eu-west-2) |
| 4 Shared modules | Done — `_shared/{http,mmax,consents,db,mock,register,report,states}.ts`, 27 Deno tests |
| 5 `mm-client` | **Deployed**; mock + one live UAT consent proven; IDV path + concurrency proven |
| 6 `mm-staff` | **Deployed**; unauthenticated paths proven; **signed-in path awaits Michael** (`node scripts/smoke-staff.mjs <ref>`) |
| 7 `store.js` | Done |
| 8 `index.html` | Done — live consent wording + Pro Mortgages SA notice; identity-question screen |
| 9 `admin.html` | Done — run check, report card, consent/IDV/withdrawal, profiles, stalled flags |
| 10 Prove it | Done except the signed-in staff path and real-bureau calls — **see `HANDOVER-2026-09-26.md`** |
| Bug hunt | 39 confirmed findings fixed in two passes; hardening migration run locally on Postgres 17 |

**Design changes made during the build (supersede §1–§3 where they differ):**
- **D14 revised:** *both* functions deploy with `--no-verify-jwt`. New-key projects sign session
  JWTs asymmetrically; `mm-staff` verifies the caller itself with `auth.getUser()`.
- **Secrets table:** bearer-like values live in `credit_check_secrets` (RLS on, no policies), not
  in hidden columns — column grants would have broken `select('*')`.
- **Registration is one module** (`_shared/register.ts`) used by the client (`mm-client
  register-consent`) *and* a staff retry (`mm-staff register-consent`) — without the retry a
  record whose 30-minute client token expired, or whose vendor call failed, was stuck forever.
- **`mm-client consent-types`** is a public, read-only action serving the configured wording
  (rendered, with version + hash), cached per isolate for an hour. In mock mode it serves the
  bundled fixture `_shared/fixtures/consent-types-active.json`.
- **Consent presentation is enforced in both modes:** registration refuses `consent_not_presented`
  / `consent_stale` unless `consents_presented` echoes the exact id + version + hash served.
- **Passport applicants** → `manual_required` server-side (`ALLOW_PASSPORT` secret) and hidden
  on the form (`ALLOW_PASSPORT` in `config.js`).
- **`mm-staff delete-record`** removes the stored PDF with the row (staff have no Storage delete
  right; a plain row delete would have orphaned the credit report — breaks "destroy on request").
- **IDV concurrency:** `idv-start` claims the round *before* calling the vendor; `idv-answer`
  atomically consumes the session reference; server enforces a 6-minute answer window.
- **Parity tests** fail if `store.js` and the server disagree on who may run a check, or if the
  admin labels, `states.ts` and the migration's CHECK list drift apart.
- **`mm-staff config`** tells the admin page the mode / IDV mode (secrets are not browser-readable).

**Test records on the register (safe to delete once the admin page is deployed):** every row
named `E2E-TEST-DELETE-ME`.

---

## 0. Read these first (10 minutes, in this order)

1. This file, fully.
2. `~/ARRABON Services/Systems/Pro Mortgages SA - Credit Check/uat-probe-results.md`
   — twelve real HTTP exchanges with the vendor's UAT. Ground truth over the spec.
3. `.../consent-types-MOMM-ACTIVE.json` — the five *active* MortgageMax consent types.
4. The two OpenAPI files in the same folder, via `jq` (the credit one is 174 KB; never
   `cat` it): `blos-credit-management-api.json`, `v3.json`.
5. `~/projects/petcare-app/supabase/functions/manage-invite/index.ts` — the Edge
   Function pattern we copy (CORS helper, envelope, service-role client, JWT gating).
6. `~/vault/Projects/Promortgage-system/architecture/decisions.md` — durable decisions.

**Never** put the subscription key, client_id, or client_secret in: this repo, the
vault, chat, or any log line. They live in `supabase/.env.mmax` (gitignored) and in
Supabase secrets. Michael sets them; you write code that reads them.

---

## 1. Decisions already made — do not relitigate

| # | Decision | Why (evidence) |
|---|---|---|
| D1 | **Auth = `Ocp-Apim-Subscription-Key` header only.** No OAuth bearer. Ship a ~30-line optional bearer module that activates only if `MMAX_OAUTH_TENANT_ID` + `MMAX_OAUTH_CLIENT_SECRET` are both set (production hedge). | T1 401 without key; T2/T3/P2/P3 reach application code with key alone, incl. the write. Both specs declare only `apiKey` schemes. |
| D2 | **Two Edge Functions with a hard boundary:** `mm-client` (anon-callable, authorised per record by `ref` + a single-purpose `idv_token`) and `mm-staff` (staff JWT via `auth.getUser()`). The anon code path can never reach `/CreditCheck/full`. | Subscription key must not ship in browser JS (Addendum cl. 6.1.2). Consultant-only billing call needs a JWT gate. |
| D3 | **IDV is a switchable stage.** Secret `MM_IDV_MODE` ∈ `off` \| `optional` \| `required`. Build every IDV state regardless; start UAT in `off`. | Whether `/full` requires `verificationSuccessCode` is unknowable without a test identity. Business analysis: report goes only to staff and the consultant gates the pull, so `off` is a defensible v1. |
| D4 | **Consent set is configuration, not code.** Default `MM_CONSENT_TYPES = ["818BB417-0963-4DFF-B7E3-09C66F6D0AF9"]` (Broad consent MM v13). Never `5911C3C5` (BetterBond wording). `762fc8a5`/`38bf94d7`/`13b88327` available by config only. | The three MOMMCreditCheck types are `active=false`, v1, BetterBond-era; `38bf94d7` makes the consumer declare an ID copy is attached. `818BB417` is active, current, is *literally* the PDF the vendor sent as "the consent we use", covers credit bureau, one-free-report, cross-border storage, and defines "MortgageMAX Licensee" = Pro Mortgages SA. |
| D5 | **`personId` = the applicant's ID number** (passport number if passport). Redact it from every log line and never log full URLs. | It is the only key the credit API could use to resolve consent; already disclosed for the check; free-text at the API (P2). |
| D6 | **Never store a vendor consent `id` as durable.** Store our `personId`, the consent-type ids + versions + declaration hashes we rendered, and a read-back snapshot from `GET /Consents?PersonId=`. Re-read immediately before any use. | P11: a repeat POST for the same (personId, consentTypeId) deletes the old record and creates a new id. The 201 body is the personId echoed, not an id (P2). |
| D7 | **`apiClientId` = the OAuth client_id GUID** from the handover email, as secret `MMAX_API_CLIENT_ID`. | Unvalidated at the API (P8 `not-a-guid` → 201). The only client identifier the vendor has issued. Confirm in passing in the vendor email. |
| D8 | **Report storage = both.** `report_json jsonb` (the structured `experianCreditCheckData`), PDF in private Storage bucket `credit-reports`, `group_id` on the row. Always call getDocument with `ReturnPdfAsBase64=true` and `RemovePdfPassword=true`. `pdf_status` is a sub-state of `report_ready`, never a blocker. | Spec + `RemovePdfPassword` param. Free-tier Edge Function CPU budget → no PDF library; detect `/Encrypt` by byte search. |
| D9 | **Atomic claim before the paid call.** `UPDATE … SET status='check_in_flight' … WHERE ref=$1 AND status IN (…) RETURNING *`; zero rows → 409. Write the outgoing request to `mm_api_log` *before* calling. | A timeout after the bureau billed and footprinted the enquiry, with no `groupId` held, is the worst failure. Two consultants clicking is prevented server-side, not by a disabled button. |
| D10 | **Status transitions become function-only.** `REVOKE INSERT, UPDATE ON credit_checks FROM authenticated` (staff keep SELECT + DELETE); all state changes go through the Edge Functions (service role). Bearer-like secrets (IDV token hash, `verification_request_number`) live in `credit_check_secrets`, which has RLS on and no policies, so no client role can read it. **The atomic claim (D9) needs no RPC**: a single conditional `update().eq('ref',r).in('status',allowed).select()` from the service role is one statement. *(Revised 2026-09-26 — column-level grants would have broken `select('*')` in store.js.)* | Today RLS `staff_all` lets a stale admin tab move a row backwards. |
| D14 | **New project uses the new key format** (`sb_publishable_…`), which is not a JWT. So `mm-client` deploys with `--no-verify-jwt` and authorises solely by `ref` + `idv_token`. `mm-staff` keeps gateway JWT verification on: a signed-in staff browser sends the user's session JWT. | Project `mxakigcvckhmyppoiuds` rebuilt 2026-09-26 in org ARRABON Paid (Pro). |
| D11 | **Passport applicants: feature-flag OFF for launch.** Keep columns. `Full.Request` has only `idNumber` — no `idType`, no DOB. | Spec. Unknowable whether `/full` accepts a passport number. |
| D12 | **Mock mode is first-class.** `MM_MODE=mock\|live`; mock serves fixtures built from the six real bodies already captured. The entire UI is built and demoed against mock. | Zero vendor dependency for UI work. |
| D13 | **Render the consent declaration from config + API, with a Pro Mortgages SA preface.** `818BB417` is HTML — sanitise and render as HTML. Above it: a short s18 notice in Pro Mortgages SA's voice (who we are, that MortgageMAX/BetterLife obtains the report from Experian on your behalf, data stored on cloud infrastructure outside SA, retention, contact). Store `declaration_hash` + `version` shown, re-fetch at post time, abort with `consent_stale` if changed. | The declarations are BetterLife's consents; Pro Mortgages SA is still the collecting responsible party under POPIA s18. `818BB417` is already at v13 — they revise. |

---

## 2. The flow you are building

```
CLIENT (index.html, anon)
  form ──▶ submit_credit_check RPC ──▶ awaiting_otp
  OTP  ──▶ confirm_consent RPC     ──▶ consent_confirmed  (mints idv_token, returns it once)
       ──▶ mm-client:register-consent  [POST /Consents → GET /Consents read-back] ──▶ consent_registered
       ──▶ if MM_IDV_MODE ≠ off:
             mm-client:idv-start   [POST /Idv/getQuestions]  ──▶ idv_in_progress | idv_unavailable
             IDV screen (questions rendered, answers chosen)
             mm-client:idv-answer  [POST /Idv/checkAnswers]  ──▶ idv_passed | idv_failed
       ──▶ done screen

CONSULTANT (admin.html, staff JWT)
  "Run credit check" ──▶ mm-staff:run-check
        atomic claim ──▶ check_in_flight
        [POST /CreditCheck/full]  ──▶ report_ready (report_json, group_id)  |  check_failed
        [GET /CreditCheck/getDocument/{groupId}/true/true] ──▶ pdf_status: stored | failed | locked
  "Fetch PDF" (retry)      ──▶ mm-staff:fetch-pdf
  "Refresh consents"       ──▶ mm-staff:refresh-consents   [GET /Consents?PersonId=]
  "Record withdrawal"      ──▶ mm-staff:record-withdrawal  [POST /Consents granted=false] ──▶ consent_withdrawn
```

### Status machine (all values, regardless of `MM_IDV_MODE`)

`awaiting_otp` → `consent_confirmed` → `consent_registered` → [`idv_in_progress` → `idv_passed` | `idv_failed` | `idv_unavailable` | **`idv_waived`**] → `check_in_flight` → `report_ready` | `check_failed`
Side states: `consent_withdrawn`, `manual_required`, `expired` (abandoned before OTP/IDV, swept by a scheduled job), `config_error` (401/403 from vendor — developer alert, never client-facing).

`idv_waived` is written when `MM_IDV_MODE=off` moves a record past IDV by policy — so the data always shows *why* a check ran without verification (waived by config vs failed vs unavailable). It makes the switch auditable.

Shared pure module `assets/report-model.js` (ES module, no DOM): `normalise(CreditCheckResponseDto) → { verdict, flags, judgements, affordability, sections }` with the string-flag allow-list parsing in one place, imported by both `admin.html` (Tier 1/2 rendering) and `mm-staff` (to populate summary columns at write time). One parser, two consumers, no drift.

Guard for `run-check` by mode: `required` → only from `idv_passed`. `optional` → from `idv_passed`, or from `consent_registered`/`idv_failed`/`idv_unavailable` with `force=true` (audited override). `off` → from `consent_registered`.

Request field values for `/full` when the consultant runs it: `isCreditCheckOnMyself=false`, `consentWasGiven=true`, `idConcent=<personId>` (best inference; vendor email confirms), `verificationSuccessCode=<VerificationResultDto.statusCode if idv_passed, else omit the key entirely>`, `userDetails` = the consultant (from a `staff_profiles` row: name, email, cell, `businessGroupName="MortgageMAX"`, `businessName="Pro Mortgages SA"`, `businessBranchName` as configured), `address` = `UserAddress` shape, `sourceSystem="PMSA-CreditCheck"`, `appName="promortgage-credit-check"`, `appVersion` = git short SHA, `extraData={"ref": <our ref>}`, `returnPdfAsBase64=false` (we fetch via getDocument), numeric fields **always numbers, never null**.

---

## 3. TODAY — in this order

Each step ends with a checkpoint for Michael. Steps 1–3 need Michael at the keyboard briefly.

### Step 1 — Tooling (Michael runs; ~10 min)
```bash
brew install deno
brew install supabase/tap/supabase
supabase login
supabase functions list --project-ref mxakigcvckhmyppoiuds
```
Do **not** `npm i -g supabase` (EACCES on this Mac). Do **not** `supabase link` (needs the DB password; not required for functions or secrets). Docker is not needed: deploy bundles remotely; there is no local `functions serve`. Tests are Deno unit tests with mocked `fetch`, plus a Node 24 harness against the *deployed* functions in mock mode.

### Step 2 — Scaffold
- `supabase/functions/deno.json` (imports `npm:@supabase/supabase-js@2`; tasks `test`, `check`).
- `supabase/functions/_shared/{http.ts,mmax.ts,consents.ts,fixtures/}`, `supabase/functions/mm-client/index.ts`, `supabase/functions/mm-staff/index.ts`, `supabase/migrations/`, `scripts/`.
- `supabase/.env.mmax.example` with every secret name and the UAT base URLs, values blank.
- `.gitignore` += `.env`, `.env.*`, `supabase/.env*`, `supabase/.temp/`, and decide `graphify-out/` (recommend ignore).
- Copy `consent-types-MOMM-ACTIVE.json` → `assets/fixtures/consent-types.json` for demo mode.

Secrets (Michael sets from the gitignored env file): `MMAX_SUBSCRIPTION_KEY`, `MMAX_CREDIT_BASE_URL`, `MMAX_CONSENT_BASE_URL`, `MMAX_API_CLIENT_ID`, `MMAX_ENV=uat`, `MM_MODE=mock`, `MM_IDV_MODE=off`, `MM_CONSENT_TYPES=["818BB417-0963-4DFF-B7E3-09C66F6D0AF9"]`, `ALLOW_PASSPORT=false`. Optional: `MMAX_OAUTH_TENANT_ID`, `MMAX_OAUTH_CLIENT_SECRET`.
```bash
supabase secrets set --env-file supabase/.env.mmax --project-ref mxakigcvckhmyppoiuds
```

### Step 3 — Migration `supabase/migrations/20260926_mortgagemax.sql` (write; Michael pastes into SQL Editor after review)
Idempotent. Header: "run after supabase-setup.sql".
1. Widen `credit_checks.status` CHECK to the full list in §2.
2. Columns on `credit_checks`: `mm_person_id text`, `consents_presented jsonb`, `consent_registered_at timestamptz`, `mm_consents_snapshot jsonb`, `mm_consents_synced_at timestamptz`, `consent_withdrawn_at timestamptz`, `idv_token_hash text`, `idv_token_expires timestamptz`, `idv_attempts int not null default 0`, `idv_started_at timestamptz`, `verification_request_number text` (server-only), `idv_questions jsonb` (questions only, never answers), `idv_result jsonb`, `idv_passed_at timestamptz`, `verification_success_code text`, `check_started_at timestamptz`, `check_request_id uuid`, `check_attempt int not null default 0`, `check_requested_by uuid`, `check_error_code text`, `check_error_text text`, `group_id text`, `bureau_enquiry_id text`, `report_json jsonb`, `affordability_json jsonb`, `report_ready_at timestamptz`, `pdf_status text check (pdf_status in ('pending','fetching','stored','failed','locked'))`, `pdf_attempts int not null default 0`, `report_pdf_path text`, `mm_env text`.
3. Tables: `mm_api_log` (ref, direction, api, method, path_redacted, http_status, content_type, body_head text (≤8 KB, PII-redacted), trace_id, latency_ms, request_id, created_at) — append-only; `consent_events` (append-only evidence: ref, consent_type_id, version, declaration_hash, granted, rendered_at, otp_confirmed_at, request_body, response_body, vendor_created_date); `report_access_log` (ref, user_id, action, created_at) — written on every admin view or download (the PCR declaration's undertaking); `staff_profiles` (user_id, full_name, email, cell, branch_name).
4. Storage: bucket `credit-reports`, private, 20 MB, `application/pdf` only. Policies: `authenticated` SELECT (for signed URLs); no INSERT/UPDATE/DELETE for anon or authenticated — only the service role writes.
5. Grants: `REVOKE UPDATE (status, idv_*, verification_*, check_*, group_id, report_*, pdf_*) ON credit_checks FROM authenticated`. Keep the note columns updatable.
6. RPC changes: `confirm_consent` returns a one-time `idv_token` (random 32 bytes, sha256 stored, 30-min expiry) alongside its current result; `submit_credit_check` stores `consents_presented` and `mm_person_id`; new SECURITY DEFINER `record_withdrawal(ref)` (staff only) and `claim_check(ref, allowed_from text[])` used by `mm-staff` for D9.
7. Realtime: `credit_checks` already enrolled; nothing to do.

Verify after paste: `select column_name from information_schema.columns where table_name='credit_checks' order by ordinal_position;`

### Step 4 — `_shared/http.ts` + `_shared/mmax.ts` + tests
- `http.ts`: port petcare's `cors()` verbatim with origins `https://mdcockcroft.github.io`, `http://localhost:8461`, `http://127.0.0.1:8461`. `Access-Control-Allow-Headers: authorization, x-client-info, apikey, content-type` (petcare's 2026-07-02 outage). Envelope `{ok:true,data}` / `{ok:false,error:{code,message,vendorCode?,traceId?}}`; codes → 401 unauthenticated, 403 forbidden, 400 bad_request, 409 invalid_state, 502 vendor_error, 504 vendor_timeout, 500 server_error.
- `mmax.ts`: `callVendor(api, method, path, {body, query, timeoutMs})`. Sets the subscription-key header (never the query variant), `Accept: application/json`, `AbortSignal.timeout`. **Branch on HTTP status first.** Read body as **text** first; sniff: `"`→JSON-encoded string, `{`/`[`→JSON, `%PDF`→bytes, `JVBERi0`→base64 PDF, `http`→URL. Normalise the five error vocabularies into one `Result {ok, http, data, text, vendorCode, vendorMessage, traceId, unknownFields}`. Success predicates: consent POST = any 2xx; getQuestions = `verificationRequestNumber` non-null AND `questions.length>0`; checkAnswers = `success===true`; full = `errorCode` empty AND `groupId` non-empty AND `experianCreditCheckData` non-null. Log unknown top-level keys once per shape. Redact `personId`/`idNumber` in every log line.
- `consents.ts`: load `MM_CONSENT_TYPES`; fetch types live (`GET /ConsentTypes` filtered by id, `active===true`, else `config_error`); substitute `${MOBusinessGroup}` → `MortgageMAX`; compute `declaration_hash` over LF-normalised text; build `CreateConsentsRequest` with `personId`, `apiClientId`, `createdBy="promortgagesa-web"`, `sourceURN="urn:promortgagesa:credit-check:<ref>"`, `context={}` (add `{"MOBusinessGroup":"MortgageMAX"}` automatically if the type's `contextDefinition` declares it).
- Fixtures from the real bodies: T1, T3, P1, P2, P3, P7, P10 (all in the probe log). Deno tests for every parser branch and every success predicate. `deno task test` green before moving on.
- Optional bearer module (D1): two scope-keyed cached tokens; scopes verbatim `api://CreditCheckManagment/.default`, `api://ConsentManagement/.default`.

### Step 5 — `mm-client` (anon) — deploy in mock, then flip `register-consent` to live
Body `{ref, idv_token, action, answers?}`. Verify `sha256(idv_token) === idv_token_hash` and not expired on every action; rate-limit ≤2 IDV rounds per ref.
- `register-consent`: require status `consent_confirmed`; POST /Consents; on any 2xx, GET /Consents?PersonId= and store snapshot; write `consent_events`; → `consent_registered`. On 401/403 → `config_error` + audit; never surface to the client.
- `idv-start` (no-op returning `{skipped:true}` when `MM_IDV_MODE=off`): POST /Idv/getQuestions with `noOfQuestions=5`, `idType="SAID"`, `clientConsent=<personId>`; store `verification_request_number` server-side (never returned to the browser), `idv_questions`; → `idv_in_progress` | `idv_unavailable` (the T3 shape).
- `idv-answer`: validate each `answerNumber` ∈ that question's `possibleAnswers`; POST /Idv/checkAnswers; store `idv_result`; → `idv_passed` (store `statusCode` as `verification_success_code`) | `idv_failed`.
Deploy: `supabase functions deploy mm-client --project-ref mxakigcvckhmyppoiuds`. Then, with Michael watching, set `MM_MODE=live` for a synthetic `personId` like `UAT-PMSA-<date>` and prove one consent lands (P2 already proved the call; this proves the deployed path).

### Step 6 — `mm-staff` (JWT)
Body `{ref, action, force?}`. `auth.getUser()`; any authenticated user is staff (matches RLS today).
- `run-check`: mode guard (§2) → `claim_check` RPC (D9) → write `mm_api_log` → POST /CreditCheck/full (90 s) → on success store `report_json`, `affordability_json`, `group_id`, `bureau_enquiry_id` (`Root.cC_ENQUIRY_ID`), → `report_ready`, `pdf_status='pending'` → immediately attempt `fetch-pdf` once, non-fatal. On business failure → `check_failed` with codes + raw body in `mm_api_log`. No automatic retry on a 200-with-error.
- `fetch-pdf`: GET getDocument `/true/true` (60 s) → decode base64 → byte-search `/Encrypt` → upload to `credit-reports/<ref>/<groupId>.pdf` → `pdf_status='stored'` | `'locked'` | `'failed'` (+ attempts).
- `refresh-consents`, `record-withdrawal` as in §2.
Mock mode returns a fixture report with a plausible `experianCreditCheckData` tree so the dashboard can be built.

### Step 7 — `assets/store.js`
`STATUS` map + chips for every new status; `fromRow` maps all new columns (never `verification_request_number` or `idv_token_hash` — exclude them from the staff `select`); `PMStore.registerConsent(ref, token)`, `idvStart`, `idvAnswer`, `runCheck(ref, force)`, `fetchPdf`, `refreshConsents`, `recordWithdrawal`, `reportPdfUrl(ref)` (signed URL, 60 s, and write `report_access_log`), `consentTypes()` (live in live mode, fixture in demo). Demo mode keeps working end-to-end with fixtures.

### Step 8 — `index.html`
- Replace the hard-coded `<ol>` in `#sec-consent .clause-box` with: (a) Pro Mortgages SA preface/s18 notice (placeholders for legal name, address, reg numbers — Michael/Liz supply; keep the visible "requires legal review" banner until they do); (b) one sanitised HTML clause-box per configured consent type, name + "MortgageMAX consent, version N" footer; (c) the existing single checkbox. Store `consents_presented` on submit.
- After OTP success: call `register-consent`; show a neutral "Registering your consent…" state; on `config_error` show "We'll be in touch" (never the vendor error).
- IDV screen `#idvPanel` (hidden unless mode ≠ off): "Step 3 of 3 · Verify your identity", loading state (bureau latency), one `<fieldset>` per question with a radiogroup from `possibleAnswers`, submit → `idv-answer`, outcomes: passed / failed (one retry if attempts < 2) / unavailable ("we could not generate questions for this ID — your consultant will contact you"). Countdown, hard-stop at 5 minutes.
- Passport radio hidden when `ALLOW_PASSPORT=false`.

### Step 9 — `admin.html`
- Filters/counts/tiles generated from `PMStore.STATUS`; tiles: Total · Awaiting SMS · Ready to run · Reports ready · Needs attention.
- Detail: consent section (types, versions, registered at, "Refresh" and "Record withdrawal"); IDV section (state, attempts, passed at; **never** answers); "Run credit check" (enabled per mode guard; `force` checkbox only in `optional`, audited); report card **Tier 1**: score + risk colour (`EnqCCCompuSCORE[0].score`, `risK_COLOUR_*`, or `ClientCustomScore`), flags from `affordabilityResponseModel` (deceased, fraud, dispute, thinFile, sequestration, debtReview*, `ragIndicator`) parsed with an explicit allow-list — **never `Boolean(str)`**, judgements counts, arrears, affordability `amount`; **Tier 2** collapsible: Summary (NLR/CCA 12/24/36, active/closed accounts, exposure, instalments), judgements, adverse, public defaults, debt restructure, enquiry counts, employers, addresses; **Tier 3**: "Open PDF" (signed URL) + "Raw JSON". `pdf_status` chip with "Fetch PDF" retry.
- Every view/download of a report writes `report_access_log`.

### Step 10 — Prove it, then commit in small steps
- `deno task test` green. Deploy both functions (`MM_MODE=mock`). Node harness `scripts/smoke.mjs` hits both with the anon key + a demo row: register → (idv skipped) → run-check → report_ready → fetch-pdf → stored (fixture PDF).
- Flip `register-consent` live once (Step 5). Everything else stays mock until test identities exist.
- Commits (show each diff first): `chore: tooling + scaffold` → `feat(db): mortgagemax migration` → `feat(edge): shared client + tests` → `feat(edge): mm-client` → `feat(edge): mm-staff` → `feat(ui): consent render + idv screen` → `feat(admin): run check + report card` → `docs: README, notes`. Also commit the previously untracked `CLAUDE.md`; ignore `graphify-out/`.

### Definition of done for today
Migration written and reviewed · both functions deployed in mock · one live consent registration proven through the deployed function · client form renders the real consent text with the preface · IDV screen exists behind the flag · admin runs a mock check and renders Tier 1 · all tests green · `git grep -n -F -f <(grep -E '^MMAX_(SUBSCRIPTION_KEY|API_CLIENT_ID)=' supabase/.env.mmax | cut -d= -f2- | grep .)` returns nothing.

---

## 4. Traps (each one cost an agent an hour to find — do not rediscover them)

- **`Full.Request.address` and `.userDetails` `$ref` themselves** in the export (spec bug). Hand-write the types: `address` → `UserAddress`, `userDetails` → `UserData`. Never codegen from this spec.
- **Non-nullable numerics must never be `null`:** `grossIncome`, `nettIncome`, `expenses`, `totalBondRepayment`, `totalBondRepaymentToBeSettled`, `repaymentTerm`, `returnPdfAsBase64`, `isCreditCheckOnMyself`, `UserAddress.captureDate`, `Idv.Get.Request.noOfQuestions`. Send `0`/`false`/ISO timestamp, or a 400 fires before your request is read.
- **P3's 404 `"No Credit Check with Id '', "`** (text/plain, trailing comma) on POST `/full` means the backend looks up an existing check by some request field before doing anything. Branch on HTTP status first; treat non-JSON as hard failure; store the text.
- **Five error vocabularies:** gateway `{statusCode,message}`; ProblemDetails `{errors{field:[…]},traceId}`; bare text; `CreditCheckResponseDto.errorCode/errorString`; IDV `responseCode/responseMessage` (undocumented). Capture `traceId` on every non-2xx — it is the vendor's support key.
- **`GET /Consents` for an unknown person returns `200 []`**, not the documented 404. Filter `granted===true` client-side; the API returns declined records too.
- **The UAT sandbox is shared and writable** (`POST /ConsentTypes` works with our key; junk types named "string" exist). The Edge Function allow-lists exactly nine paths and nothing else, ever.
- **GUID casing is mixed** (`5911C3C5-…` vs `762fc8a5-…`); compare case-insensitively. **Scope strings have double spaces**; split on `/\s+/`. **Declarations have CRLF**; normalise before hashing. **`createdDate` has 7 fractional digits**; timestamptz accepts it.
- **`818BB417`'s declaration is HTML** (`<p>`, `<a>`, `<sup>`); the v1 ones are plain text with `\r\n`. Render accordingly; sanitise.
- **`consentWasGiven`** on `/full` is echoed back as `affordabilityResponseModel.consentWasGiven` — it is the affordability flag, distinct from bureau consent.
- **Affordability may be empty** on a Full-Credit-Report-only subscription (sold separately at R750/m). Store it, render it if present, promise nothing.
- **`verificationRequestNumber` is a bearer-like token** — anyone holding it can submit answers. Server-side only.
- **IDV `noQuestions` (T3 shape) will hit thin-file consumers and probably every passport holder.** Land in `idv_unavailable`, never in a blocked state.
- **The SMS OTP is still `demo_otp` in the RPC return.** Not today's scope, but no real client may use the form until a gateway exists — the OTP is the consent evidence.

---

## 5. Vendor contact — one email, after two checks

Before sending: (1) Michael checks the **API Manager portal** for a UAT test-data pack or test identities (the 09-08 note says per-API required info lives there); (2) nothing else is probed with synthetic ID numbers — a Luhn-valid guess can be a real person.

Draft: `~/ARRABON Services/Systems/Pro Mortgages SA - Credit Check/vendor-email-2026-09-26-DRAFT.md`. Two asks, two confirmations. Nothing that the spec or probes already answer.

---

## 6. Not today, but before any real client

| Item | Owner | Why |
|---|---|---|
| SMS gateway (Clickatell / BulkSMS / Twilio), strip `demo_otp` | Michael + Opus | The OTP is the consent evidence. Compliance blocker, no vendor dependency. |
| POPIA Operator Agreement (ARB-Q-2026-002 §7 requires it before commencement) | Michael | ARRABON is Pro Mortgages SA's operator handling credit data. |
| s18 notice content: registered legal name, address, company/FSP/NCR numbers; fix "Pro Mortgage / Pro Mortgage SA / Pro Mortgages SA" inconsistency | Liz | Placeholders are still in the page rail. |
| Business decisions: IDV mode for go-live; passport holders' manual path; whether reports are shared with agents/attorneys; accept IDV as added scope vs ARB-Q-2026-002 | Liz + Michael | Product, not engineering. |
| Legal-adviser list: POPIA s57(1)(c) prior authorisation for credit-reporting purposes; Information Officer; PAIA manual; the PCR declaration's undertakings (access log, destroy-after-purpose) | Liz's adviser | Flag, do not assert. |
| Production: new host + key; day-one smoke = `GET /ConsentTypes` with the prod key; re-verify D1 | Michael + Opus | APIM policies commonly differ UAT → prod. |
| Reissue ARB-Q-2026-002 (expired 18 Sept; §2.3 says "direct Experian", wrong; IDV unscoped) | Michael | Commercial hygiene. |
