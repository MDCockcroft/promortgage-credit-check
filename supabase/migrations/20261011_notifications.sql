-- ============================================================
-- Pro Mortgage credit-check — email notifications to the person an application belongs to
-- (apply AFTER 20261010_retention.sql; then deploy mm-maintenance, set RESEND_API_KEY and NOTIFY_FROM,
-- and schedule the job — supabase/cron/notify.sql)
-- Idempotent: safe to re-run. Paste into Supabase → SQL Editor → Run. One transaction.
-- ============================================================
-- Why: client feedback, 18 Nov 2026 — staff only learn that a client has finished (or got stuck) by
-- looking at the dashboard. mm-maintenance now emails the owner of the link the client used; this
-- file gives it what it needs in the database. Nothing is sent until the function has its mail key
-- and the job is scheduled.
-- ============================================================
-- What this does:
--   1. notification_log: one row per application per kind ('ready' | 'attention'). first_seen_at is
--      the settle clock; sent_at set = the email went, and never goes again. Server-only.
--   2. FIRST RUN ONLY: every application that already exists is marked as told, so switching this on
--      does not email anybody about old records.
--   3. notification_candidates(): the applications that may call for an email, who to tell (the
--      owner if that login is active, otherwise every active administrator) and what the log already
--      holds. Server-only.
-- ============================================================

begin;

-- Is this the very first run? Decided BEFORE the table is created, and kept for this transaction only.
select set_config('pm.notify_first_run', case when to_regclass('public.notification_log') is null then '1' else '0' end, true);

-- ------------------------------------------------------------
-- 1. The log
-- ------------------------------------------------------------
create table if not exists public.notification_log (
  ref           text not null references public.credit_checks(ref) on delete cascade,
  kind          text not null check (kind in ('ready', 'attention')),
  first_seen_at timestamptz not null default now(),
  sent_at       timestamptz,
  sent_to       uuid[],          -- the logins it went to (addresses stay in auth.users)
  note          text,
  primary key (ref, kind)
);
alter table public.notification_log enable row level security;   -- no policy: the service role only
revoke all on table public.notification_log from anon, authenticated;
create index if not exists notification_log_pending_idx on public.notification_log (first_seen_at) where sent_at is null;

-- ------------------------------------------------------------
-- 2. Old records are not announced
-- ------------------------------------------------------------
do $$
begin
  if current_setting('pm.notify_first_run', true) = '1' then
    insert into public.notification_log (ref, kind, sent_at, note)
    select c.ref, k.kind, now(), 'existed before notifications'
      from public.credit_checks c cross join (values ('ready'), ('attention')) as k(kind)
    on conflict do nothing;
  end if;
end $$;

-- ------------------------------------------------------------
-- 3. What may call for an email, and who to tell
-- ------------------------------------------------------------
-- Only statuses an email can come from (the rule itself lives in _shared/notify.ts), and only
-- applications from the last 30 days, so the list stays short for ever.
create or replace function public.notification_candidates()
returns table (ref text, status text, has_id_copy boolean, id_copy_source text,
               recipient_ids uuid[], recipient_emails text[], log jsonb)
language sql stable security definer set search_path = public, pg_temp
as $$
  with usable as (            -- a login an email may go to
    select s.user_id, s.role, u.email
      from staff_members s join auth.users u on u.id = s.user_id
     where s.active and u.email is not null and u.deleted_at is null
       and (u.banned_until is null or u.banned_until < now())
  ), admins as (
    select array_agg(user_id order by email) as ids, array_agg(email order by email) as emails
      from usable where role = 'admin'
  )
  select c.ref, c.status, c.id_document_path is not null, c.id_document_source,
         case when o.user_id is not null then array[o.user_id] else a.ids end,
         case when o.user_id is not null then array[o.email::text] else a.emails::text[] end,
         coalesce((select jsonb_agg(jsonb_build_object('kind', l.kind, 'first_seen_at', l.first_seen_at, 'sent_at', l.sent_at))
                     from notification_log l where l.ref = c.ref), '[]'::jsonb)
    from credit_checks c
    left join usable o on o.user_id = c.consultant_id
    cross join admins a
   where c.status in ('consent_registered', 'idv_waived', 'idv_passed', 'manual_verified',
                      'idv_failed', 'idv_unavailable', 'manual_required', 'config_error')
     and c.created_at > now() - interval '30 days'
   order by c.created_at
$$;
revoke all on function public.notification_candidates() from public, anon, authenticated;
grant execute on function public.notification_candidates() to service_role;

commit;
