# ADR 0001: BullMQ on Redis for the pipeline's queues

- **Status:** accepted
- **Date:** recorded 2026-10-13, after the fact: the decision was made when the pipeline was built.
  The options below are the ones the design's constraints rule out, not a record of a bake-off.

## Context

Alert webhooks arrive in storms: one failure fires many rules on many pods, and Alertmanager resends
firing alerts. The ingest endpoint has to acknowledge fast and never lose an accepted delivery, and
every later step (ingest, cluster, triage) runs on workers that can die mid-job. The constraints:

- **The ack path must not touch Postgres.** Postgres is where clustering does its work, and during
  a storm that work is heavy: in the k6 storm (`just load-storm`), Postgres peaked at 5.3 cores, all
  of it the worker's. An ack that waited on Postgres would inherit that contention.
- **Every step must be idempotent**, because a dead worker's job runs again, and senders retry.
- **Redis is already required** at the ack path: the `Idempotency-Key` store (`SET NX EX 86400`)
  needs a shared store faster than Postgres.
- Triage needs retries with backoff that respects a provider's `Retry-After`, a rate limit
  (`TRIAGE_MAX_PER_MINUTE`), and a dead-letter queue that only a person drains.
- The codebase is TypeScript end to end.

## Decision

Use BullMQ (6.x) on a single Redis 7 instance, configured `--maxmemory-policy noeviction` (an
evicted queue key is a silently lost job) and `--appendonly yes`.

- **Deterministic job ids** (`jobIds` in `@tripwire/contracts/queues`) make re-adding a job a
  no-op while BullMQ still holds it: completed jobs are kept for an hour (a day for triage), up to
  the latest 10,000 per queue. Past that, the Postgres backstops (`ingests.idempotency_key`,
  `incident_alerts.alert_id`, `triage_runs.job_key`) make a rerun write nothing new.
- **Admission control reads the queue, not Postgres**: it samples the ingest queue's waiting count
  every 250 ms and sheds above `INGEST_HIGH_WATER` (see [ADR 0003](0003-degradation-policy.md)).
- **Retries** use BullMQ's attempts with a custom full-jitter backoff; triage's limiter and the
  `triage-dlq` queue are BullMQ features too, so no second system holds retry state.

## Options ruled out

- **A Postgres-backed queue** (pg-boss, graphile-worker, `SKIP LOCKED`): one fewer system, and an
  enqueue could share a transaction with the write it follows. But every webhook would become a
  Postgres write on the ack path: the contention the first constraint exists to avoid.
- **RabbitMQ**: a mature broker with dead-lettering, but no deduplication by message id; the
  idempotency store would still be Redis, so it adds a system without removing one.
- **Kafka**: ordering and replay that nothing here needs, and partitions to size for storms.
- **SQS**: FIFO queues deduplicate only within 5 minutes, and local development would need an
  emulator.

## Consequences

- **One Redis does two jobs**: the ack path's idempotency keys and enqueues, and every job
  transition the workers make. In the k6 storm it averaged about half a core at about 1,700
  requests/s and held 255 MiB of jobs at its peak. It is the first component that doesn't scale by
  adding processes ([README: what breaks first at 10x](../../README.md#what-breaks-first-at-10x));
  moving the idempotency keys to their own instance is the first step when that matters.
- **Durability is Redis's.** With `appendonly yes` and the default `appendfsync everysec`, a Redis
  crash can lose up to about a second of acknowledged deliveries. Alertmanager resends alerts that
  are still firing, so a lost delivery comes back, late. A deployment that can't accept that needs
  `appendfsync always` (slower acks) or a replicated Redis.
- **Memory bounds the backlog.** With `noeviction` a full Redis fails writes instead of dropping
  jobs, and the api answers a failed enqueue with a 503 and `Retry-After`, never a 202 for work it
  didn't queue.
- Postgres stays the source of truth for everything after ingest; Redis only holds work in flight.
