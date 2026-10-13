#!/usr/bin/env bash
# The README demo's stack (docs/demo/demo.tape; `just demo-gif`). Needs `just infra-up`.
#   up         the api and worker from source, on their own database (tripwire_demo, recreated)
#              and queue prefix (demo), with a high-water mark low enough for a small storm to shed
#   incidents  waits for the worker to finish, then shows what the demo's alerts became
#   down       stops them, drops tripwire_demo and deletes the demo's Redis keys
set -euo pipefail
cd "$(dirname "$0")/../.."

compose=(docker compose -f infra/docker-compose.yml)
state=${TMPDIR:-/tmp}/tripwire-demo
export DATABASE_URL="postgres://tripwire:tripwire@localhost:${TRIPWIRE_PG_PORT:-15432}/tripwire_demo"
export QUEUE_PREFIX=demo INGEST_HIGH_WATER=${DEMO_HIGH_WATER:-300} TRIAGER=baseline
export OTEL_SDK_DISABLED=true

psql() { "${compose[@]}" exec -T postgres psql -X -U tripwire -v ON_ERROR_STOP=1 "$@"; }
redis() { "${compose[@]}" exec -T redis redis-cli "$@"; }

# Jobs the worker hasn't finished, across the queues the demo uses.
backlog() {
  local total=0 queue list n
  for queue in ingest cluster triage; do
    for list in wait active; do
      n=$(redis LLEN "demo:$queue:$list")
      total=$((total + n))
    done
  done
  echo "$total"
}

start() { # app log-level
  (cd "apps/$1" && LOG_LEVEL=$2 exec node --conditions=@tripwire/source \
    --env-file-if-exists=../../.env --import tsx src/main.ts) >"$state/$1.log" 2>&1 &
  echo $! >"$state/$1.pid"
}

case ${1:-} in
up)
  mkdir -p "$state"
  psql -d tripwire -q -c "DROP DATABASE IF EXISTS tripwire_demo WITH (FORCE)" \
    -c "CREATE DATABASE tripwire_demo"
  pnpm --silent --filter @tripwire/db db:migrate >/dev/null
  start api warn
  start worker info
  for _ in $(seq 1 120); do
    if curl -sf "http://127.0.0.1:${API_PORT:-4000}/v1/healthz" >/dev/null &&
      grep -q 'worker started' "$state/worker.log"; then
      exit 0
    fi
    sleep 0.5
  done
  echo "the api or worker didn't start: see $state/" >&2
  exit 1
  ;;
incidents)
  for _ in $(seq 1 120); do
    left=$(backlog)
    untriaged=$(psql -d tripwire_demo -Atc "select count(*) from incidents i where not exists (
      select 1 from triage_runs r where r.incident_id = i.id and r.status in ('succeeded', 'failed'))")
    ((left == 0 && untriaged == 0)) && break
    printf '\r\033[2K  the worker is still at it: %s jobs to go' "$left"
    sleep 0.5
  done
  printf '\r\033[2K'
  psql -d tripwire_demo -At -c "select format('%s alerts stored, %s incidents opened',
    to_char((select count(*) from alerts), 'FM999,999'), (select count(*) from incidents))"
  echo
  psql -d tripwire_demo -P footer=off -c "
    select i.service,
           to_char((select count(*) from incident_alerts ia where ia.incident_id = i.id),
                   'FM999,999') as alerts,
           coalesce(r.status::text, 'queued') as triage,
           coalesce(r.model, '') as triager,
           coalesce(h.title, '') as \"top hypothesis\"
      from incidents i
      left join triage_runs r on r.incident_id = i.id
      left join hypotheses h on h.triage_run_id = r.id and h.rank = 1
     order by i.created_at"
  ;;
down)
  for app in api worker; do
    [[ -f $state/$app.pid ]] && kill "$(cat "$state/$app.pid")" 2>/dev/null || true
  done
  for _ in $(seq 1 30); do
    alive=0
    for app in api worker; do
      [[ -f $state/$app.pid ]] && kill -0 "$(cat "$state/$app.pid")" 2>/dev/null && alive=1
    done
    ((alive == 0)) && break
    sleep 0.5
  done
  rm -f "$state"/*.pid
  psql -d tripwire -q -c "DROP DATABASE IF EXISTS tripwire_demo WITH (FORCE)"
  "${compose[@]}" exec -T redis sh -c "redis-cli --scan --pattern 'demo:*' |
    xargs -r -n 500 redis-cli UNLINK >/dev/null
    redis-cli --scan --pattern 'tripwire:idempotency:demo-*' | xargs -r -n 500 redis-cli UNLINK >/dev/null"
  ;;
*)
  echo "usage: $0 up|incidents|down" >&2
  exit 2
  ;;
esac
