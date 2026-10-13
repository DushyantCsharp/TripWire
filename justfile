set dotenv-load := true
set shell := ["bash", "-euo", "pipefail", "-c"]

demo_version := "3.1.0"
demo_dir := "infra/otel-demo/upstream"
infra := "docker compose -f infra/docker-compose.yml"
demo := "docker compose -p otel-demo --project-directory " + demo_dir + " --env-file " + demo_dir + "/.env --env-file " + demo_dir + "/.env.override --env-file infra/otel-demo/tripwire.env -f " + demo_dir + "/compose.yaml -f " + demo_dir + "/compose.full.yaml -f " + demo_dir + "/compose.observability.yaml -f infra/otel-demo/compose.tripwire.yaml"

# List recipes
default:
    @just --list --unsorted

setup:
    pnpm install

# Regenerate packages/contracts/src/generated from its schema/ (commit the result)
generate:
    pnpm generate

# Run api, worker and console in watch mode (start infra first)
dev:
    pnpm turbo run dev --filter='./apps/*'

build:
    pnpm turbo run build

# e.g. `just test --filter=@tripwire/agent`
test *args:
    pnpm turbo run test {{ args }}

lint:
    pnpm turbo run lint

typecheck:
    pnpm turbo run typecheck

fmt:
    pnpm format

# Everything CI runs: lint, typecheck, test, boundaries, formatting
check:
    pnpm check

clean:
    pnpm clean

# Tripwire's stack: postgres+pgvector, redis, otel-collector, jaeger, prometheus, grafana
infra-up:
    {{ infra }} up -d --wait

infra-down:
    {{ infra }} down

# Stop Tripwire's stack and delete its volumes
infra-reset:
    {{ infra }} down --volumes

infra-logs *services:
    {{ infra }} logs -f {{ services }}

# Clone the OpenTelemetry Demo at the pinned version
demo-fetch:
    #!/usr/bin/env bash
    set -euo pipefail
    if [ ! -d {{ demo_dir }} ]; then
      git -c advice.detachedHead=false clone --quiet --depth 1 --branch {{ demo_version }} https://github.com/open-telemetry/opentelemetry-demo.git {{ demo_dir }}
    fi
    have=$(git -C {{ demo_dir }} describe --tags)
    if [ "$have" != "{{ demo_version }}" ]; then
      echo "{{ demo_dir }} is at $have, expected {{ demo_version }}: delete it and re-run" >&2
      exit 1
    fi

# Start the full demo with its observability stack (~6 GB of Docker memory)
demo-up: demo-fetch
    {{ demo }} up -d --remove-orphans

demo-down:
    {{ demo }} down

demo-logs *services:
    {{ demo }} logs -f {{ services }}

# Integration tests against real services in containers (needs Docker)
test-integration *args:
    pnpm turbo run test:integration {{ args }}

# Every unit and integration test in one Jest run, with the coverage gate CI enforces (needs Docker)
coverage *args:
    pnpm coverage {{ args }}

# Kill workers mid-job and check for duplicate incidents or triage reports (needs `just infra-up`)
chaos *args:
    pnpm --filter @tripwire/worker chaos {{ args }}

# Index runbooks/*.md into Postgres for get_runbook (needs `just infra-up`); rerun after editing one
runbooks-index:
    pnpm --filter @tripwire/worker runbooks:index

# Capture golden-set cases from the running demo (needs `just demo-up`): `--pilot`, `--cases a,b`, `--all`
eval-capture *args:
    pnpm --filter @tripwire/evals capture {{ args }}

# Run the golden set and report against evals/thresholds.json (needs Docker; claude needs ANTHROPIC_API_KEY)
eval *args:
    pnpm --filter @tripwire/evals eval {{ args }}

# Replay the nightly subset's recorded model responses against its baseline: free, no key (needs Docker)
eval-replay *args:
    pnpm --filter @tripwire/evals eval --replay evals/replay --subset nightly --baseline evals/replay/baseline.json {{ args }}

# Re-record the replay subset from the model (about $2) and write its baseline; commit evals/replay/
eval-record:
    -pnpm --filter @tripwire/evals eval --record evals/replay --subset nightly
    pnpm --filter @tripwire/evals eval --replay evals/replay --subset nightly --write-baseline evals/replay/baseline.json

# Unit-test the eval alert rules at the demo's real cadence (needs Docker)
test-rules:
    docker run --rm -v "$PWD/evals:/rules:ro" --entrypoint promtool quay.io/prometheus/prometheus:v3.13.1 test rules /rules/alert-rules.test.yaml

# k6 alert storm at 2k req/s against the api and worker images, then the report (needs `just infra-up`; about 8 min)
load-storm:
    infra/load/run.sh

# Build an image for this machine: `just image api|worker|console` (release.yml builds both architectures)
image target='api':
    docker buildx build --target {{ target }} -t tripwire-{{ target }}:local --load .

# Write a migration for packages/db/src/schema.ts changes (then add its .down.sql)
db-generate:
    pnpm --filter @tripwire/db db:generate

# Apply pending migrations; `just db-migrate --to=N` stops after N
db-migrate *args:
    pnpm --filter @tripwire/db db:migrate {{ args }}

# Roll back every migration above N (-1 rolls back everything)
db-rollback to:
    pnpm --filter @tripwire/db db:rollback --to={{ to }}

db-status:
    pnpm --filter @tripwire/db db:status

# Replace all data with the deterministic demo set
db-seed:
    pnpm --filter @tripwire/db db:seed

# Fill alerts.fingerprint_v2 (packages/db/MIGRATIONS.md)
db-backfill *args:
    pnpm --filter @tripwire/db db:backfill {{ args }}
