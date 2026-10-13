#!/usr/bin/env bash
# The k6 alert storm against the api and worker images (`just load-storm`; infra/README.md "Load").
# Two runs at the same arrival rate, each on its own queue prefix so the first's backlog can't
# shed the second:
#   ack   INGEST_HIGH_WATER raised so nothing is shed: ack latency at 2k req/s, then dedupe
#   shed  the default high-water: what a storm past it gets (503 with Retry-After)
# k6 summaries, docker stats and reports land in infra/load/results/. The storm writes to its own
# database (tripwire_load), recreated each time, and removes its queues' Redis keys when done.
# Needs `just infra-up`. Env: LOAD_RATE, LOAD_STEADY, LOAD_RAMP (compose.load.yaml),
# LOAD_DRAIN_SECONDS (how long run 1's backlog may drain before the dedupe score, default 120).
set -euo pipefail
cd "$(dirname "$0")/.."

compose=(docker compose -f docker-compose.yml -f load/compose.load.yaml)
stamp=$(date -u +%Y%m%d-%H%M%S) # lower case: QUEUE_PREFIX is [a-z0-9-]
results=$PWD/load/results
drain_seconds=${LOAD_DRAIN_SECONDS:-120}
export LOAD_DATABASE=tripwire_load
export LOAD_SAMPLE_RATIO=${LOAD_SAMPLE_RATIO:-0.01}
database_url="postgres://tripwire:tripwire@localhost:${TRIPWIRE_PG_PORT:-15432}/$LOAD_DATABASE"
prefixes=()
sampler=
mkdir -p "$results"

redis() { "${compose[@]}" exec -T redis redis-cli "$@"; }

finish() {
  [[ -n $sampler ]] && kill "$sampler" 2>/dev/null || true
  "${compose[@]}" stop api worker >/dev/null 2>&1 || true
  for prefix in ${prefixes[@]+"${prefixes[@]}"}; do
    "${compose[@]}" exec -T redis sh -c \
      "redis-cli --scan --pattern '$prefix:*' | xargs -r -n 500 redis-cli UNLINK >/dev/null"
  done
}
trap finish EXIT

# Ingest and cluster jobs still waiting or running under a prefix.
backlog() {
  local total=0 queue list n
  for queue in ingest cluster; do
    for list in wait active; do
      n=$(redis LLEN "$1:$queue:$list")
      total=$((total + n))
    done
  done
  echo "$total"
}

# One line per container every couple of seconds: epoch, name, CPU %, memory.
sample_stats() {
  while :; do
    docker stats --no-stream --format '{{.Name}},{{.CPUPerc}},{{.MemUsage}}' \
      tripwire-api-1 tripwire-worker-1 tripwire-redis-1 tripwire-postgres-1 2>/dev/null |
      sed "s/^/$(date +%s),/"
  done
}

peaks() {
  awk -F, '{ cpu = $3; sub("%", "", cpu); if (cpu + 0 > max[$2]) max[$2] = cpu + 0 }
    END { for (name in max) printf "   %s peak CPU %.0f%%\n", name, max[name] }' "$1"
}

run() { # name expect high-water
  local expect=$2 id="storm-$stamp-$1" prefix="load-$stamp-$1" from to drained k6_status=0
  export LOAD_RUN_ID=$id LOAD_EXPECT=$expect LOAD_HIGH_WATER=$3 LOAD_QUEUE_PREFIX=$prefix
  prefixes+=("$prefix")
  echo "== $id: INGEST_HIGH_WATER $3, expect $expect"
  "${compose[@]}" up -d --wait api worker
  from=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  sample_stats >"$results/$id.stats.csv" &
  sampler=$!
  "${compose[@]}" --profile load run --rm --no-deps k6 || k6_status=$?
  # The apps export metrics every 5 s: let the last of the run's arrive.
  sleep 10
  to=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  if [[ $expect == ack ]]; then
    local deadline=$((SECONDS + drain_seconds)) left
    while left=$(backlog "$prefix") && ((left > 0 && SECONDS < deadline)); do sleep 5; done
    echo "   backlog after up to ${drain_seconds}s of draining: $left jobs"
  fi
  drained=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  kill "$sampler" 2>/dev/null || true
  wait "$sampler" 2>/dev/null || true
  sampler=
  peaks "$results/$id.stats.csv"
  echo "   k6 exit status $k6_status (99: a threshold failed)"
  DATABASE_URL=$database_url pnpm --dir .. --silent --filter @tripwire/evals load-report \
    --run "$id" --from "$from" --to "$to" --summary "$results/$id.json" --expect "$expect" \
    --drained "$drained" --sample-ratio "$LOAD_SAMPLE_RATIO"
}

echo "== building the api and worker images"
"${compose[@]}" build api worker

echo "== a fresh $LOAD_DATABASE"
"${compose[@]}" stop worker >/dev/null 2>&1 || true
"${compose[@]}" exec -T postgres psql -U tripwire -d tripwire -v ON_ERROR_STOP=1 -q \
  -c "DROP DATABASE IF EXISTS $LOAD_DATABASE WITH (FORCE)" -c "CREATE DATABASE $LOAD_DATABASE"
DATABASE_URL=$database_url pnpm --dir .. --silent --filter @tripwire/db db:migrate

run ack ack 1000000
run shed shed 10000
