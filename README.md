# Pro Mortgage — Credit Check Tool

Client credit-check consent flow + staff register for Pro Mortgage SA (bond originator).

- `index.html` — client-facing consent form (send this link to clients)
- `admin.html` — staff register, behind Supabase Auth login
- `assets/store.js` — dual-mode data layer (Supabase live / localStorage demo)
- `supabase-setup.sql` — database schema, RLS and RPCs (run once per project)

Backend: Supabase (anon browsers can only call the submit/confirm RPCs; staff
read the table after login). The anon key in `assets/config.js` is public by
design — row-level security protects the data.

Pending phases: SMS gateway for the OTP, TransUnion Consumer Profile API.
