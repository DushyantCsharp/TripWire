#!/usr/bin/env bash
# Every migration, up and down, through the real CLI (@tripwire/db db:migrate / db:rollback): up,
# dump the schema, roll everything back, check nothing is left but the bookkeeping table, up again,
# and require the same schema. CI's `migrations` job runs it; it runs locally against
# `just infra-up` too:
#   scripts/migration-roundtrip.sh postgres://tripwire:tripwire@127.0.0.1:15432/tripwire tripwire-postgres-1
# The dumps run inside the server's container, so pg_dump matches the server's version.
set -euo pipefail

server_url=${1:?usage: migration-roundtrip.sh <postgres server URL> <its container>}
container=${2:?usage: migration-roundtrip.sh <postgres server URL> <its container>}
db="migration_roundtrip_$$"
user=$(node -e 'console.log(decodeURIComponent(new URL(process.argv[1]).username))' "$server_url")
database_url=$(node -e 'const u = new URL(process.argv[1]); u.pathname = `/${process.argv[2]}`; console.log(u.href)' "$server_url" "$db")
work=$(mktemp -d)

psql_in() { docker exec "$container" psql -U "$user" -v ON_ERROR_STOP=1 -tAq "$@"; }
# PG 16.10+ writes a random \restrict key into every dump unless one is given.
dump() { docker exec "$container" pg_dump -U "$user" -d "$db" --schema-only --no-owner --restrict-key=roundtrip; }
cli() { DATABASE_URL=$database_url pnpm --silent --filter @tripwire/db "$@"; }
cleanup() {
  psql_in -d postgres -c "DROP DATABASE IF EXISTS \"$db\" WITH (FORCE)" >/dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT

psql_in -d postgres -c "CREATE DATABASE \"$db\""

echo "== up"
cli db:migrate
dump > "$work/first.sql"

echo "== down to nothing"
cli db:rollback --to=-1
left=$(psql_in -d "$db" -c "
  SELECT string_agg(name, ', ' ORDER BY name) FROM (
    SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'S')
       AND c.relname <> 'tripwire_migrations'
    UNION ALL SELECT 'type ' || t.typname FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname = 'public' AND t.typtype = 'e'
    UNION ALL SELECT 'function ' || p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
    UNION ALL SELECT 'extension ' || extname FROM pg_extension WHERE extname <> 'plpgsql'
  ) leftovers")
if [ -n "$left" ]; then
  echo "rolling everything back left: $left" >&2
  exit 1
fi
applied=$(psql_in -d "$db" -c 'SELECT count(*) FROM tripwire_migrations')
if [ "$applied" != 0 ]; then
  echo "rolling everything back left $applied migrations recorded as applied" >&2
  exit 1
fi

echo "== up again"
cli db:migrate
dump > "$work/second.sql"

if ! diff -u "$work/first.sql" "$work/second.sql"; then
  echo "the schema after down and up again differs from the first up (diff above)" >&2
  exit 1
fi
echo "migrations round-trip cleanly: $(grep -c '^CREATE TABLE' "$work/first.sql") tables, same schema both times"
