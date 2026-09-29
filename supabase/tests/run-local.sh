#!/bin/bash
# Apply the whole schema to a THROWAWAY local Postgres 17 and run the SQL tests.
#   supabase/tests/run-local.sh [work-dir]        (needs Homebrew postgresql@17)
# Nothing here touches Supabase. The work dir is deleted and recreated on every run.
set -euo pipefail
export LC_ALL=en_US.UTF-8          # without it Postgres refuses to start on this Mac
BIN=/opt/homebrew/opt/postgresql@17/bin
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../.." && pwd)"
WORK="${1:-${TMPDIR:-/tmp}/pm-pgtest}"; PORT=54329
PSQL=("$BIN/psql" -h 127.0.0.1 -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -q)

"$BIN/pg_ctl" -D "$WORK/data" stop -m immediate >/dev/null 2>&1 || true
rm -rf "$WORK"; mkdir -p "$WORK"
"$BIN/initdb" -D "$WORK/data" -U postgres -A trust >/dev/null
# TCP only: the socket path under a long temp dir exceeds the 103-byte limit.
printf "unix_socket_directories = ''\nlisten_addresses = '127.0.0.1'\nport = %s\n" "$PORT" >> "$WORK/data/postgresql.conf"
"$BIN/pg_ctl" -D "$WORK/data" -l "$WORK/log.txt" -w start >/dev/null
trap '"$BIN/pg_ctl" -D "$WORK/data" stop -m fast >/dev/null 2>&1 || true' EXIT

run() {
  echo "== $(basename "$1")"
  local out
  if ! out="$("${PSQL[@]}" -f "$1" 2>&1)"; then
    echo "$out" | grep -v -E "NOTICE|wal_level" | tail -6; echo "MIGRATION FAILED: $(basename "$1")"; exit 1
  fi
}
run "$HERE/standins.sql"
run "$ROOT/supabase-setup.sql"
MIGS=("$ROOT"/supabase/migrations/*.sql)
LAST="${MIGS[${#MIGS[@]}-1]}"
for f in "${MIGS[@]}"; do
  if [ "$f" = "$LAST" ]; then
    # A login that exists BEFORE the newest migration (the one the seed makes an administrator)...
    "${PSQL[@]}" -c "insert into auth.users (id, email) values ('00000000-0000-0000-0000-00000000000a', 'admin@test')"
    # ...and three that exist but must NOT be seeded: unconfirmed, anonymous, banned.
    "${PSQL[@]}" -c "insert into auth.users (id, email, email_confirmed_at, is_anonymous, banned_until) values
      ('00000000-0000-0000-0000-0000000000f1', 'unconfirmed@test', null, false, null),
      ('00000000-0000-0000-0000-0000000000f2', null, now(), true, null),
      ('00000000-0000-0000-0000-0000000000f3', 'banned@test', now(), false, now() + interval '1 year')"
    run "$f"
    # ...and one created AFTER it, to prove a re-run promotes nobody.
    "${PSQL[@]}" -c "insert into auth.users (id, email) values ('00000000-0000-0000-0000-00000000000e', 'nobody@test')"
    echo "-- again (must be idempotent)"; run "$f"
  else
    run "$f"
  fi
done
FAIL=0
for t in "$HERE"/*_test.sql; do
  echo "== TEST $(basename "$t")"
  out="$("${PSQL[@]}" -f "$t" 2>&1)" || FAIL=1
  echo "$out" | sed -E 's/^psql:[^ ]+ //' | grep -E "^(NOTICE:  T[0-9]|ERROR|CONTEXT|FAIL)" || true
done

# Every older file must now REFUSE to run: each recreates an "any signed-in user may read" rule.
echo "== GUARDS: older files refuse to run once roles exist"
for f in "$ROOT/supabase-setup.sql" "${MIGS[@]}"; do
  [ "$f" = "$LAST" ] && continue
  if out="$("${PSQL[@]}" -f "$f" 2>&1)"; then echo "FAIL: $(basename "$f") ran again"; FAIL=1
  elif ! echo "$out" | grep -q "STOP: .* is older than this database"; then echo "FAIL: $(basename "$f") failed for another reason:"; echo "$out" | tail -3; FAIL=1
  else echo "ok: $(basename "$f") refused"; fi
done
open="$("${PSQL[@]}" -At -c "select count(*) from pg_policies where schemaname in ('public','storage') and roles @> '{authenticated}' and qual = 'true'")"
pub="$("${PSQL[@]}" -At -c "select count(*) from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'credit_checks'")"
if [ "$open" != "0" ] || [ "$pub" != "0" ]; then echo "FAIL: $open open policies, credit_checks published: $pub"; FAIL=1; else echo "ok: no open policy, credit_checks not published"; fi

if [ "$FAIL" = 0 ]; then echo "ALL SQL TESTS PASSED"; else echo "SQL TESTS FAILED"; exit 1; fi
