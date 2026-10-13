# ADR 0003: Degradation policy

- **Status:** accepted
- **Date:** recorded 2026-10-13, after the fact: this collects rules that the code and CLAUDE.md
  already enforce, so they can be judged as one policy.

## Context

Tripwire runs during other systems' incidents, which is exactly when its own dependencies are
likeliest to be slow or down: telemetry backends under load, a model provider rate-limiting, a
storm of alerts. Every failure has to land somewhere: on the sender, on a queue, on a person, or on
the quality of the report. This ADR decides where.

## Decision

Four rules, in order of precedence:

1. **Never claim work that wasn't done.** A 202 means the delivery is queued; a report says which
   evidence it couldn't get; a partial report says why it stopped. Nothing degrades silently.
2. **Push back on the sender before dropping anything.** Overload becomes a 503 with `Retry-After`,
   not a timeout or a lost delivery.
3. **Degrade the answer, not the run.** A missing backend or an exhausted budget gives a smaller
   report with lower confidence, never an error that leaves the on-call with nothing.
4. **Fail closed where it's irreversible.** Write actions need an approval record; nothing about
   degradation relaxes that.

What each failure does:

| Failure                                                                         | Behaviour                                                                                                                         | Where                                | Evidence                                                                                         |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Ingest queue above `INGEST_HIGH_WATER` (default 10,000 waiting)                 | 503 + `Retry-After`: the time to drain back to the mark at the measured rate, plus 0–25% jitter, 1–60 s                           | `apps/api/src/ingest/admission.ts`   | k6 shed run: 49.4% shed at about 1,700 req/s, every 503 with `Retry-After`, queue held at 10,148 |
| Admission can't read the queue                                                  | Keeps deciding on the last depth it read; logs the first failure                                                                  | same                                 | `admission.test.ts`                                                                              |
| Redis down (idempotency store or enqueue)                                       | 503 + `Retry-After`, and the idempotency key is released so the retry goes through; never a 202 for work that wasn't queued       | `apps/api/src/ingest/routes.ts`      | `webhooks.test.ts`                                                                               |
| Postgres down                                                                   | The ack path doesn't notice; worker jobs fail as `RetryableError` and back off                                                    | `apps/worker/src/errors.ts`          | `errors.test.ts`                                                                                 |
| A worker dies mid-job                                                           | The job runs again; every step is idempotent                                                                                      | job ids, advisory locks, unique keys | `just chaos`                                                                                     |
| A telemetry backend is down or unconfigured                                     | The tool answers `unavailable`; the report records the gap and lowers confidence; the run continues                               | `packages/agent/src/tools/`          | a live run with every backend unavailable still ended `report_submitted`                         |
| The model returns 429, 5xx or times out                                         | Retry with full-jitter backoff, never sooner than `Retry-After`; 5 attempts, then `triage-dlq`                                    | `apps/worker`                        | `backoff.test.ts`                                                                                |
| A job fails for good                                                            | Dead-lettered with its error class and attempt history; only a person redrives it (`redriveTriageJob`)                            | worker, api                          | no automatic redrive, by rule                                                                    |
| A run nears or hits a limit (8 tool calls, 40k input or 4k output tokens, 60 s) | Near it, the loop asks for the report; past it, it stops and stores a partial report with its `stopReason`                        | `packages/agent/src/loop.ts`         | scripted-model tests                                                                             |
| The model's report is invalid, or it refuses                                    | One repair turn, then partial; with no usable report, hypotheses fall back to ranking alert labels (`basis: 'alert_labels'`)      | `report.ts`, `loop.ts`               | scripted-model tests                                                                             |
| Telemetry text tries to steer the agent                                         | Treated as data inside escaped tags; `propose_action` policy refuses services the run never named, uncited evidence, scaling to 0 | `untrusted.ts`, `policy.ts`          | `injection.test.ts`, the eval's injection cases                                                  |
| The OpenTelemetry collector is down                                             | Exports fail in the background (batched spans, periodic metrics); requests never wait on them                                     | `packages/telemetry`                 | the SDK's export model                                                                           |
| A write action without a valid approval                                         | Refused: no execution, whatever else is degraded                                                                                  | `authorizeExecution`                 | its table-driven test                                                                            |

## Options ruled out

- **Accept everything and queue it**: a storm then fills Redis (`noeviction` turns that into failed
  writes for everyone) and delays every incident behind the backlog. In the k6 storm without
  shedding, an alert waited a median 90 s for its incident (136 s at worst); with shedding at the
  default mark, 25 s (50 s at worst).
- **Fail the triage run when evidence is missing**: the on-call gets nothing at the moment a
  partial answer helps most.
- **Automatic redrive of dead letters**: a job that failed five times with backoff is usually
  failing for a reason a retry won't fix, and redriving it automatically hides that.

## Consequences

- Senders must back off on a 503 for shedding to work; one that retries at once makes the storm
  worse. `Retry-After` tells a sender how long; Alertmanager retries failed notifications with its
  own backoff.
- Reports can be partial, so every consumer has to read `stopReason` and each evidence item's
  availability. The GraphQL schema defines both; its report resolvers and the console's views
  aren't built yet, and must show them when they are.
- An outage of every telemetry backend still costs a full model run that can only rank alert
  labels. Skipping the model when nothing is reachable would save that cost; it isn't done yet.
