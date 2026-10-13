# Local infrastructure

Two independent compose projects:

| Project     | What it is                                                                                                       | Start           |
| ----------- | ---------------------------------------------------------------------------------------------------------------- | --------------- |
| `tripwire`  | `docker-compose.yml`: Tripwire's dependencies and its own observability                                          | `just infra-up` |
| `otel-demo` | Upstream OpenTelemetry Demo 3.1.0: the Astronomy Shop plus its telemetry backends. Faults are injected via flagd | `just demo-up`  |

They stay apart on purpose. The agent investigates the demo's backends, and Tripwire's own spans must
never show up there as evidence. `just demo-fetch` clones upstream into `otel-demo/upstream/`
(gitignored), and `otel-demo/compose.tripwire.yaml` is layered on top. The full demo needs about 6 GB
of Docker memory.

## Ports

Host ports bind to loopback unless noted. Defaults avoid the ports the demo publishes and common local
services (5432, 6379, 16686, 3000). Override them via root `.env`.

| Service                                                       | Port                 | Override                                              |
| ------------------------------------------------------------- | -------------------- | ----------------------------------------------------- |
| Postgres 16 + pgvector                                        | 15432                | `TRIPWIRE_PG_PORT`                                    |
| Redis 7                                                       | 16379                | `TRIPWIRE_REDIS_PORT`                                 |
| OTel collector, OTLP gRPC / HTTP                              | 14317 / 14318        | `TRIPWIRE_OTLP_GRPC_PORT` / `TRIPWIRE_OTLP_HTTP_PORT` |
| Jaeger UI                                                     | 16687                | `TRIPWIRE_JAEGER_PORT`                                |
| Prometheus                                                    | 19090                | `TRIPWIRE_PROMETHEUS_PORT`                            |
| Grafana (anonymous admin)                                     | 13000                | `TRIPWIRE_GRAFANA_PORT`                               |
| API / console (not containers)                                | 4000 / 3000          | `API_PORT`                                            |
| Demo storefront, `/jaeger/ui`, `/grafana`, `/feature` (flagd) | 8080, all interfaces | upstream                                              |
| Demo Prometheus                                               | 9090, all interfaces | upstream                                              |
| Demo Jaeger query API                                         | 26686                | `DEMO_JAEGER_PORT`                                    |
| Demo OpenSearch (logs)                                        | 29200                | `DEMO_OPENSEARCH_PORT`                                |

## Golden-set capture

`just eval-capture` (evals/src/capture) records the evals' golden set from the demo: it switches one
flagd fault on through flagd-ui, reads the alerts the demo's Prometheus raises, snapshots logs,
traces and metrics, then switches the fault off and waits for recovery. For that, the overlay:

- pins the demo images to 3.1.0 (`otel-demo/tripwire.env`; upstream's `.env` says `latest`);
- mounts `otel-demo/prometheus-config.yaml` (upstream's, plus `rule_files`) and
  `evals/alert-rules.yaml` into the demo's Prometheus, and raises its memory limit to 600M.

After editing the rules, `docker restart prometheus` (its data survives). A `POST /-/reload` isn't
enough on Docker Desktop: the single-file bind mount keeps the old file size, so Prometheus reads
the new rules truncated and refuses them.

A case takes about 12 minutes, so the full set is several hours: start it and leave it. It resumes
where it stopped (`--all` skips captured cases). It refuses to start while any fault flag is on or
alerts fire, and switches its fault off again when it finishes or fails, and on Ctrl-C or SIGTERM
(a second signal exits at once). A SIGKILL can't be caught: check flagd-ui (`/feature`) after one,
or `git -C infra/otel-demo/upstream checkout src/flagd/demo.flagd.json`.

The rules have unit tests at the demo's real cadence (`evals/alert-rules.test.yaml`, run by CI):
`docker run --rm -v "$PWD/evals:/rules:ro" --entrypoint promtool quay.io/prometheus/prometheus:v3.13.1 test rules /rules/alert-rules.test.yaml`.

## Tripwire's images

The root `Dockerfile` builds the api, worker and console (`just image api|worker|console` for this
machine); `release.yml` publishes both architectures to GHCR on a version tag. Their environment,
ports and one-off commands are in CLAUDE.md, "CI and release". Locally they reach `just infra-up`'s
services at `host.docker.internal` (Postgres on 15432, Redis on 16379).

## Tripwire's telemetry

Run the api and worker with `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:14318` (root `.env`; the
dev scripts preload the SDK) and their traces reach Jaeger as `tripwire-api` and `tripwire-worker`,
their metrics Prometheus. Grafana (http://localhost:13000) provisions the Tripwire folder's SLO
dashboard from `grafana/provisioning/dashboards/json/` and two alert rules from
`grafana/provisioning/alerting/rules.yaml`. Both are read at startup: edit the files, then
`docker compose restart grafana`. What each metric means is in CLAUDE.md, "Observability".

## Load test

`just load-storm` (`load/run.sh`) builds the api and worker images and runs them next to this
project's Redis, Postgres and collector (`load/compose.load.yaml`), then points k6
(`load/storm.js`) at the api: signed Alertmanager deliveries of one alert each, 8 problems × 2 alert
rules × 50 pods (`load/storm-groups.json`), ramping to `LOAD_RATE` (2000/s) over 20 s and holding it
for 60 s. It runs twice, each run on its own queue prefix:

1. **ack**: `INGEST_HIGH_WATER` raised so nothing is shed. k6 fails the run if the 202s' p99 is
   50 ms or more, or if it couldn't keep the rate. The worker then drains for up to
   `LOAD_DRAIN_SECONDS` (120) before the dedupe score.
2. **shed**: the default high-water. A 503 is fine here only with a `Retry-After`.

Each run leaves `load/results/<run>.json` (k6's summary), `<run>.stats.csv` (docker stats) and
`<run>.report.{md,json}` (`pnpm --filter @tripwire/evals load-report`: server-side latency, shedding
and queue depth from Prometheus, the dedupe ARI from Postgres, how far a sampled trace reaches from
Jaeger). The storm uses its own database, `tripwire_load`, dropped and recreated each time, and
deletes its Redis keys when it ends. CPU limits are 2 cores each for the api, worker and k6
(`LOAD_*_CPUS`); the whole thing takes about 8 minutes of high CPU.
