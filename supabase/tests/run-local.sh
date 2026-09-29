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
if [ "$FAIL" = 0 ]; then echo "ALL SQL TESTS PASSED"; else echo "SQL TESTS FAILED"; exit 1; fi
