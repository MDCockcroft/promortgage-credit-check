-- ============================================================
-- Pro Mortgage credit-check — the MortgageMAX person record a consent is keyed to
-- (apply AFTER 20261006_retire_otp_and_one_phone.sql; additive, so before or after the deploy)
-- Idempotent: safe to re-run. Paste into Supabase → SQL Editor → Run. One transaction.
-- ============================================================
-- Why: MortgageMAX (20 Oct 2026) keys consent to a person record in its People domain, not to the
-- raw ID number. The functions look the person up (or create them) before registering consent and
-- keep the id here; the consent read-back, a withdrawal and the credit check's idConcent then use it.
-- Records registered before the switch have no id and keep the ID number as their key.
-- ============================================================

begin;

alter table public.credit_checks add column if not exists bt_person_id text;
-- which MortgageMAX environment minted it (uat / prod): an id from the other environment is re-resolved
alter table public.credit_checks add column if not exists bt_person_env text;
create index if not exists credit_checks_bt_person_id_idx on public.credit_checks (bt_person_id);

-- The API log gains the third vendor API (the inline check from 20260926 is named by Postgres).
alter table public.mm_api_log drop constraint if exists mm_api_log_api_check;
alter table public.mm_api_log add constraint mm_api_log_api_check check (api in ('credit', 'consent', 'people'));

commit;

-- ------------------------------------------------------------
-- Verify (run separately, AFTER the block above):
--
--   select column_name from information_schema.columns
--    where table_schema = 'public' and table_name = 'credit_checks' and column_name = 'bt_person_id';   -- one row
--   select pg_get_constraintdef(oid) from pg_constraint where conname = 'mm_api_log_api_check';       -- ... 'people'
-- ------------------------------------------------------------
