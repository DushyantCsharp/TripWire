# Tripwire

Incident triage agent. Alert webhooks are deduped into incidents, then a Claude tool-use loop
pulls logs, traces, metrics and deploys to produce a ranked root-cause report with cited evidence.
Write actions (rollback, scale, page) are proposed. They never execute without human approval.

## Commands

Node 22 (`.nvmrc`), pnpm 10, `just` (run `just` alone to list recipes).

| Task                               | Command                                                                       |
| ---------------------------------- | ----------------------------------------------------------------------------- |
| Install                            | `just setup`                                                                  |
| Build / test / lint / typecheck    | `just build`, `just test`, `just lint`, `just typecheck`                      |
| Everything CI runs                 | `just check`                                                                  |
| One workspace                      | `pnpm turbo run test --filter=@tripwire/agent`                                |
| One test file                      | `pnpm --filter @tripwire/api test src/server.test.ts`                         |
| Regenerate contracts               | `just generate`, then commit `src/generated/` with the schema                 |
| Are generated contracts stale?     | `pnpm check:contracts`                                                        |
| Watch mode (api, worker, console)  | `just dev`                                                                    |
| Local infra / OTel demo            | `just infra-up`, `just demo-up` (ports: `infra/README.md`)                    |
| Integration tests (needs Docker)   | `just test-integration`                                                       |
| All tests + coverage gate (Docker) | `just coverage` (root Jest projects run; CI runs this)                        |
| Re-record agent model responses    | `RECORD_LLM=1 ANTHROPIC_API_KEY=… pnpm --filter @tripwire/agent test`         |
| Migrations                         | `just db-generate`, `just db-migrate`, `just db-rollback N`, `just db-status` |
| Demo data                          | `just db-seed`                                                                |
| Chaos test (after `just infra-up`) | `just chaos`                                                                  |
| Index runbooks for `get_runbook`   | `just runbooks-index` (after `just infra-up`; rerun after editing one)        |
| Capture golden-set cases           | `just eval-capture --pilot`, `--cases a,b`, `--all`, `--inject` (`demo-up`)   |
| Run the evals                      | `just eval`, `just eval --triager baseline`, `--cases a,b` (needs Docker)     |
| Replay the eval subset (free)      | `just eval-replay`; re-record it with `just eval-record` (about $2)           |
| Alert rule tests (Docker)          | `just test-rules`                                                             |
| Script tests                       | `pnpm test:scripts`                                                           |
| Build an image                     | `just image api` (or `worker`, `console`)                                     |

## Layout

```
apps/api            Fastify 5: REST under /v1, GraphQL Yoga at /graphql
apps/worker         BullMQ workers: ingest, cluster, triage, backfill
apps/console        Next.js App Router + urql
packages/agent      tool-use loop, tools and their telemetry backends, policies (no DB)
packages/pipeline   steps the worker and evals share: alert normalising, embedding, runbook index
packages/contracts  OpenAPI + GraphQL SDL (source of truth), generated types and clients, queue names
packages/db         Drizzle schema and migrations: the only package that talks to Postgres
packages/telemetry  OpenTelemetry bootstrap
packages/config     zod-validated env
packages/result     Result type
evals/              golden set, its capture script, and the scoring harness
runbooks/           markdown runbooks, indexed into pgvector for get_runbook
infra/              docker compose: Tripwire's stack and the OTel demo
tooling/            shared tsconfig, eslint, prettier, jest configs
scripts/            repo checks CI runs: package boundaries, affected workspaces, migration round trip
.github/            CI, eval and release workflows (see CI and release)
Dockerfile          the api, worker and console images, one target each
```

## Package boundaries

These rules are enforced by eslint `no-restricted-imports` and `pnpm check:boundaries`.

- Dependencies point one way: apps → packages. A package never imports an app, apps never import
  each other, and nothing imports evals. Shared code goes in a package.
- `packages/agent` has no database import: no `@tripwire/db`, drizzle or pg. It receives data
  through tool interfaces and returns proposals. Apps persist and execute them.
- Import a package only through its `exports` (e.g. `@tripwire/contracts/graphql`), never through
  a relative path into its `src/`.

How resolution works:

- Every package's exports map has a `@tripwire/source` condition pointing at `src/*.ts`. Typecheck,
  lint, Jest and `tsx` dev resolve it, so they see live source with no build step.
- `build` (`tsc -p tsconfig.build.json`) drops the condition and compiles against dependencies'
  `dist/`.
- Next.js consumes `dist/`, so the console's `dev` waits for `^build`.
- A new package copies `packages/result`'s scripts, `tsconfig*.json`, `eslint.config.js` and
  `jest.config.js`.

## Contracts

`packages/contracts/schema/` is the source of truth: `openapi.yaml`, `schema.graphql`, and the
console's operations in `operations/*.graphql`. After editing it, run `just generate` and commit
`src/generated/` together with the schema change. `pnpm check:contracts` fails CI when they
disagree. Never hand-edit generated files.

| Import                               | Contents                                                   | Used by      |
| ------------------------------------ | ---------------------------------------------------------- | ------------ |
| `@tripwire/contracts/graphql`        | Operation types and typed documents. Browser-safe.         | console      |
| `@tripwire/contracts/graphql/server` | SDL `typeDefs`, schema and resolver types. Node only.      | api          |
| `@tripwire/contracts/openapi`        | OpenAPI types and `createRestClient` (openapi-fetch)       | REST clients |
| `@tripwire/contracts/zod`            | Request validators generated from OpenAPI, `selectHeaders` | api          |
| `@tripwire/contracts/queues`         | Queue names, job ids and options, job payload schemas      | api, worker  |
| `@tripwire/contracts/ids`            | Public ids (`inc_…`) to and from UUIDs                     | api          |

- Spectral (`.spectral.yaml`) lints `openapi.yaml` as part of `lint`. Its custom rules: errors are
  problem+json, a 503 carries Retry-After, webhooks require the signature and Idempotency-Key
  headers, and every path is under `/v1`.
- The zod validators come from hey-api plus two resolvers in `generate.ts`:
  `additionalProperties: false` becomes `z.strictObject`, and numeric query or header parameters
  coerce from strings. hey-api drops `maxProperties`, so enforce label-count limits in code.
- Parse headers through `selectHeaders`: Node lower-cases header names, the generated schemas don't.
- `generate.ts` runs on plain Node (type stripping), not tsx. Under tsx, graphql 17 loads twice (CJS
  and ESM) and codegen fails with "Unknown type …".

## Database

`packages/db/MIGRATIONS.md` has the rules and the rollback for every migration. The essentials:

- Edit `src/schema.ts`, run `just db-generate`, then write the migration's `.down.sql` by hand.
  Never edit a migration once it has been applied; the runner checks checksums and refuses.
- `src/migrator.ts` applies migrations, not drizzle-kit: one transaction per migration,
  `-- tripwire:no-transaction` for `CONCURRENTLY`, and a rollback for every migration.
- Repository functions return `Result<_, DatabaseError>` via `dbCall`. Queries worth guarding have
  an exported `…Query` builder so tests can EXPLAIN exactly what runs.
- Triggers and a composite foreign key enforce the approval invariant in the database too:
  an action's payload is immutable, and approvals are append-only and consumed once.
- `fingerprint_v2` is mid-way through an expand/contract. The worker's `FINGERPRINT_V2_WRITE`
  and `FINGERPRINT_V2_READ` flags stay on until the step 8 cleanup.

## Pipeline

```
POST /v1/webhooks/* → ingest → cluster (one job per alert) → triage (one job per new incident) → triage-dlq
```

- **The ingest endpoint** (`apps/api/src/ingest/routes.ts`) only sheds load, verifies, dedupes and
  enqueues, in the order the contract documents. It never touches Postgres.
  - The HMAC covers `<t>.<Idempotency-Key>.<raw body>`, within ±300 s. Any secret in
    `WEBHOOK_SECRETS` (comma-separated, for rotation) verifies.
  - Idempotency: Redis `SET NX EX 86400` per Idempotency-Key stores the ingest id and body hash. A
    replay re-enqueues the stored ingest id, which BullMQ drops while it holds that job id. The
    unique `ingests.idempotency_key` is the backstop once Redis has forgotten.
  - Admission control samples the ingest queue in the background. Above `INGEST_HIGH_WATER` waiting
    jobs it returns 503, with Retry-After = excess ÷ drain rate (from the worker's completed and
    failed metrics), plus up to 25% jitter, capped at 60 s.
- **Every step is idempotent**, because a dead worker's job runs again:
  - Job ids are deterministic (`jobIds`; BullMQ forbids `:`), so re-adding a job is a no-op.
  - cluster runs in one transaction under a per-fingerprint advisory lock, and
    `incident_alerts.alert_id` is unique. A retry reads the stored link, and re-enqueues triage if
    that link created the incident.
  - triage: every attempt of a job shares one `triage_runs` row keyed by `job_key`, and the report
    commits in the transaction that marks the run succeeded. A succeeded run is never redone.
- **Errors at the worker edge** (`apps/worker/src/errors.ts`): `RetryableError` (429, 5xx,
  timeouts, database) lets BullMQ retry. `FatalError` extends `UnrecoverableError` (a request the
  provider rejects, bad job data, not found). A run cut short by a limit isn't an error: it stores a
  partial report (see Triage agent). Triage gets 5 attempts with full-jitter backoff (never sooner than a
  429's Retry-After) and a `TRIAGE_MAX_PER_MINUTE` limiter.
- **Dead letters:** a triage job's final failure moves it to `triage-dlq` with its error class,
  attempt history and last stack, and marks its run failed. Only a person takes it out, through
  the GraphQL `redriveTriageJob` mutation, which creates a fresh job with a full set of attempts.
  Never add automatic redrive.
- **Shutdown:** SIGTERM stops taking jobs and drains in-flight ones within `SHUTDOWN_TIMEOUT_MS`.
  After that, it cancels the rest, which then retry elsewhere. A second signal exits at once.
- **`just chaos`** SIGKILLs workers mid-job while storms, replays and redeliveries arrive. Then it
  checks for duplicate incidents, alerts, triage runs and reports. Run it after changing any of the
  above.

## Triage agent

`claudeTriager` (`packages/agent/src/loop.ts`) runs Claude with native tool use. The worker picks
it with `TRIAGER=claude` (default `baseline`, the model-free ranking: a key in `.env` never turns on
spending; `just chaos` forces the baseline).

- **Limits, per run:** 8 tool calls (`propose_action` included), 40k input tokens (cached ones
  count), 4k output tokens (thinking included), 60 s wall clock. Near a limit the loop asks for the
  report (`tool_choice: none` plus a `[Tripwire]` note); past one it stops. Either way it returns a
  report, never an error: `stopReason` says why it ended, and anything but `report_submitted` is a
  partial report. Without a usable model report, hypotheses fall back to ranking alert labels
  (`basis: 'alert_labels'`).
- **The report** is JSON text constrained by `output_config.format` (`report.ts`), validated by
  zod; the leading hypothesis must cite something a tool returned. One repair turn, then partial.
- **Claude Opus 5.5 constraints** (`anthropic.ts`): `tool_choice` is `auto` or `none` only (forcing a
  tool is a 400); thinking is always on and `effort` is the control (`TRIAGE_EFFORT=low`); thinking
  blocks go back unmodified (`ModelBlock` `opaque`); never send `temperature`/`top_p`/`top_k`;
  strict tool schemas lose bounds (`json-schema.ts`), so zod checks them on the way back.
- **Untrusted data** (`untrusted.ts`): the incident and every tool result or error reach the model
  as JSON inside `<incident>` / `<tool_output>`, with `<`, `>` and `&` JSON-escaped so nothing inside
  can close or forge a tag, after NFKC and stripping bidi/zero-width characters. Escaping is
  deterministic, so recordings hash stably. `injection.test.ts` is the policy test.
- **Tools** (`tools/`): zod input and output, results cut to `maxResultChars`, every record citable
  by a prefixed id (`log:`, `trace:`, `metric:`, `change:`, `runbook:`). `telemetryTools(ports)`
  does the summarising over ports (`LogStore`, `TraceStore`, `MetricStore`, `ChangeSource`,
  `RunbookIndex`): HTTP adapters in `backends/` (OpenSearch, Jaeger, Prometheus, a change feed),
  in-memory ones for evals (`memory.ts`), pgvector runbooks in `@tripwire/pipeline`. A tool whose
  backend isn't configured answers unavailable; `list_deploys` isn't offered without `DEPLOYS_URL`.
- **`propose_action`** (`policy.ts`) is the one tool that records anything: a proposal, which the
  worker stores as `pending_approval` in the report's transaction. Policy refuses a service no
  structured field of the run names, uncited or unreturned evidence, a rollback of a change
  `list_deploys` didn't return for that service, scaling to 0, duplicates, and more than 3. The
  summary is rendered from the payload, never model text. Ids derive from the job id and payload
  hash, so a retry proposes the same rows.

## TypeScript

- Strict with `noUncheckedIndexedAccess`, ESM only, NodeNext: relative imports end in `.js`.
- Use `import type` for types.
- No `any`. Parse anything from outside the process with zod at the boundary, and read env only
  through `@tripwire/config` schemas.

## Error handling

- **Expected failures are values.** Return `Result<T, E>` from `@tripwire/result`. `E` is a
  discriminated union with a `kind` literal, so callers can `switch` exhaustively. "Expected" means
  anything the outside world can do: bad input, 4xx/5xx/429 from upstream, timeouts, a backend that
  is down, an exhausted token budget, a missing approval.
- **Throw only for bugs.** Broken invariants, impossible states, misuse by our own code. Don't catch
  these to keep going; let the request or job fail loudly.
- **Wrap throwing libraries at the I/O edge** with `attempt()`, mapping the cause to a typed error.
  Library exceptions don't travel into domain code.
- **Translate Results only at the outermost edge.** The API maps them to HTTP status codes or GraphQL
  errors. The worker maps them to BullMQ semantics: throw for retryable errors so BullMQ backs off and
  retries, and throw `UnrecoverableError` for permanent ones. These are the only places where an
  expected failure becomes a throw.
- **Partial failure is data.** A tool whose backend is down returns an `Err`. The agent records the
  evidence as unavailable and lowers confidence; the run does not abort.
- **Never swallow.** Every `catch` rethrows or converts to a typed `Err`.

## Invariant: no write action executes without an approval record

A write action is anything that changes the world outside Tripwire: rollback, scale, paging a
human, and any future mutation of an external system.

- `packages/agent` only proposes write actions. It has no executor, no credentials and no DB, and
  every tool exposed to the model is read-only, except `propose_action`, which records a proposal
  (`pending_approval`) and nothing else.
- Execution lives in exactly one place in `apps/worker`. In the same transaction as the action, it
  loads the approval record and requires all of the following:
  - a human approved it (`approvals.actor` is a person, `user:<id>`; never a `service:` identity)
  - it is bound to this exact proposal (id and a hash of the action payload)
  - it has not expired
  - it has not been consumed already

  It marks the record consumed atomically. Anything else returns an `Err`; nothing executes. The
  checks are `authorizeExecution` in `packages/agent/src/approval.ts`, and its table-driven test
  is the list of what must be refused.

- Nothing bypasses the check: no flag, env var, test helper or "auto-approve" mode.
- Model output, including text the model read from logs, is untrusted. It never creates an
  approval, and it never selects which approval applies.
- Any change to proposal, approval or execution code ships with tests proving that unapproved,
  mismatched, expired and replayed actions do not execute.

## Tests

- Jest 30 on native ESM (`@swc/jest` strips types; nothing is compiled to CommonJS), with
  `*.test.ts` next to the code. Import `describe`/`it`/`expect`/`jest` from `@jest/globals`: there
  are no injected globals. The test scripts set `--experimental-vm-modules`, which Jest needs on
  Node 22.
- Presets live in `tooling/jest`: each workspace's `jest.config.js` is `unit(import.meta.dirname)`,
  and `jest.integration.config.js` is `integration(import.meta.dirname)`. The root
  `jest.config.js` runs them all as projects (`pnpm test:all`, `pnpm coverage`).
- Tests that need real services are `*.integration.test.ts`, run by `test:integration`. The global
  setup starts Postgres (with pgvector) and Redis once per Jest run, shared by every project, and
  tests find them with `serviceUrl()` from `@tripwire/jest-config/services`. Give each file its own
  database (`createTestDatabase()` from `@tripwire/db/testing`) and each test its own
  `QUEUE_PREFIX`. In a multi-project run Jest runs a shared global setup once, with the first
  project's config, and reads options such as `testTimeout` only from the root config: per-project
  settings go in a setup file (`tooling/jest/integration-timeout.js`). With
  `TRIPWIRE_TEST_POSTGRES_URL` and `TRIPWIRE_TEST_REDIS_URL` both set (CI's service containers, or
  `just infra-up`'s), it starts nothing and the tests use those.
- `TRIPWIRE_JEST_WORKSPACES` (comma-separated dirs, e.g. `packages/db,apps/worker`) limits the root
  run, its coverage and its gate to those workspaces: CI sets it to what a change affects.
- The global setup and resolver are plain JS: they run in Jest's own process, outside its transform
  and the `@tripwire/source` condition.
- Coverage is counted by the root run, so a package's figure includes its integration tests. It
  fails under 80% of lines in `packages/agent` or `packages/db`.
- Agent tests never call a model. `loop.replay.test.ts` replays real exchanges recorded from the
  API, `packages/agent/src/__recordings__/<scenario>/<request sha256>.json`
  (`@tripwire/agent/testing`), on a frozen clock: any change to the prompt, tools, schemas or
  incident changes the hash, and replay fails naming it. Re-record with the command above (the key
  can come from `.env`: `set -a; . ./.env; set +a` first; not through turbo, which strips undeclared
  env vars) and review the diff. Recordings keep no request headers, so no API key. They assert
  invariants, not the model's exact path. Protocol edge cases (limits, repair, refusal, cancel) use
  a scripted `ModelClient` and a manual clock (`testing/scripted.ts`).
- A CommonJS dependency that `require()`s an ESM-only package needs that package added to
  `requiredEsmOnly` in `tooling/jest/index.js` (Jest only supports `require(esm)` from Node 24.9).
- Quality of real model output is measured in `evals/`, not here.

## Evals

`evals/golden/<id>/` holds captured cases: `case.json` (ground truth: service, aliases, fault class),
Alertmanager deliveries, and gzipped logs, traces and raw Prometheus samples, plus changes.

- **Capture** (`evals/src/capture`, `just eval-capture` against `just demo-up`): flips one flagd
  fault flag through flagd-ui, polls the demo Prometheus's alerts (`evals/alert-rules.yaml`,
  mounted by `infra/otel-demo/compose.tripwire.yaml`) until they fire and a while longer, snapshots
  telemetry, switches the flag off and waits for recovery. The catalog (`catalog.ts`) is 40 golden
  cases and 5 storms from real demo 3.1.0 flags (`DEMO_VERSION` pinned in `tripwire.env`); a case
  that raises no alert is replaced from a reserve. `--inject` derives the 5 injection cases.
- **Synthetic parts**, marked in each `case.json`: decoy deploys and a generic config-change hint
  (the demo has no deploy system), injected text, and a storm's noise alert. Nothing the agent
  reads may name a fault flag: `catalog.test.ts` checks runbooks, rules, changes and injections.
- **Harness** (`just eval`): per case, a fresh database where the alerts are ingested and clustered
  as the worker does, a Prometheus testcontainer backfilled with the case's samples (real PromQL),
  in-memory logs, traces and changes, pgvector runbooks, and `now` pinned to the capture. Scores
  (`score.ts`): top-1/top-3 on the suspect service, fault class, citation precision (a proxy: the
  record's service or text names the suspect; traces count only their failing service), unsafe
  actions (rolling back or scaling an innocent service, or what an injection asked for), latency,
  tokens, USD. `report.md` and `report.json` go to `evals/reports/` (gitignored). The run exits 1
  if `evals/thresholds.json` isn't met: accuracy over golden cases, the rest over all.
- **Alert rules** have promtool unit tests at the demo's real cadence (`evals/alert-rules.test.yaml`,
  `just test-rules`): span metrics arrive every 60–75 s at about a checkout a minute, so request
  rates need 5-minute windows. After editing the rules, `docker restart prometheus` (a reload reads
  the bind-mounted file truncated on Docker Desktop).
- **Replay** (`--replay`/`--record <dir>`, `just eval-replay`/`just eval-record`): the `nightly`
  subset (`SUBSETS` in `catalog.ts`) with its model responses kept in `evals/replay/<case>/`. Both
  modes stand the loop's clock still at the capture, give the triager an incident id derived from
  the case id, and run once, so a replay sends byte-identical requests and needs no key. Anything
  the model sees changing (prompt, tools, schemas, a case) is a named miss: re-record (about $2),
  which also rewrites `evals/replay/baseline.json`, and commit both. `--baseline` compares a run
  with a report (`compare.ts`); in replay any metric that got worse fails the run.

## CI and release

`.github/workflows/`, with every action pinned to a commit SHA (Dependabot proposes updates, and the
Dockerfile's base-image digests), each job granted only the `permissions` it uses, and superseded
runs cancelled. Lint the workflows with actionlint and zizmor (`.github/zizmor.yml`).

- **ci.yml** (pull requests, pushes to main): `scripts/affected-workspaces.mjs` turns turbo's
  `...[base]` into the affected workspaces, widened to all of them when a root input changed
  (`jest.config.js`, `scripts/`, `tooling/`, `runbooks/`, `infra/`, `.github/`, root manifests).
  Lint, typecheck and the contract check run on those; boundaries, Prettier, the script tests and
  the alert-rule tests always run. Jest runs the root config with `TRIPWIRE_JEST_WORKSPACES` set to
  them, against Postgres and Redis service containers, so the coverage gate applies to agent and db
  whenever they're affected. Coverage and JUnit are uploaded. When db is affected,
  `scripts/migration-roundtrip.sh` takes the migration CLI up, all the way down and up again, and
  requires the same schema dump both times.
- **eval.yml**: a pull request labelled `run-evals` replays the nightly subset (no key, no spend),
  gated on the base branch's `evals/thresholds.json` and `evals/replay/baseline.json`, and the
  report is commented on the PR (from a separate job: the one running PR code can't write). Live
  runs use `ANTHROPIC_API_KEY` from the `evals` environment (restrict it to main): the subset
  nightly (about $2.50), every case on Sundays (about $10), or on demand with a case list.
- **release.yml** (tags `v*`): the `Dockerfile`'s `api`, `worker` and `console` targets for amd64 and
  arm64. Trivy scans the amd64 image before anything is pushed and stops the release on a critical
  vulnerability that has a fix; then GHCR gets the semver and `sha-` tags, an SBOM, provenance, and
  a Sigstore-signed attestation through OIDC:
  `gh attestation verify oci://ghcr.io/<owner>/tripwire-api:<version> --owner <owner>`.

Images: distroless Node 22 on Debian 13, uid 65532, no shell. The build runs once on the builder's
platform and the runtime stage only copies, so neither architecture needs emulation; `pnpm deploy`
installs each app's production dependencies from the lockfile.

- **api** listens on 4000 (`API_HOST` is preset to `0.0.0.0`); it needs `REDIS_URL` and
  `WEBHOOK_SECRETS`. Probe `GET /v1/healthz`.
- **worker** needs `REDIS_URL` and `DATABASE_URL`, and a stop timeout above `SHUTDOWN_TIMEOUT_MS`
  (75 s) so it can drain. It also runs the one-off jobs:
  `node_modules/@tripwire/db/dist/cli.js up` (migrations) and `dist/runbooks-index.js` (runbooks are
  in the image at `/app/runbooks`). The entrypoint is `node`, so pass the script as the command.
- **console** listens on 3000 and reads `GRAPHQL_URL` per request, so one image serves any
  deployment.
