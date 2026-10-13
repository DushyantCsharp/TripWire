# ADR 0002: Our own migration runner, a rollback for every migration, expand/contract for breaks

- **Status:** accepted
- **Date:** recorded 2026-10-13, after the fact. The rules themselves live in
  [`packages/db/MIGRATIONS.md`](../../packages/db/MIGRATIONS.md); this records why.

## Context

The schema (`packages/db/src/schema.ts`, Drizzle) changes while the pipeline keeps taking storms of
alerts. Two needs pull against Drizzle's own migrator:

- **Online index builds.** Large tables (`alerts` grows by one row per delivered alert, about 2 KB
  each with its indexes) need `CREATE INDEX CONCURRENTLY`, which can't run inside a transaction.
  Drizzle's migrator applies every pending migration in one transaction.
- **Rollback.** A bad release must be reversible by a command, not by restoring a backup, at least
  for additive changes. Drizzle's migrator has no down migrations.

And one need that no runner solves on its own: changing what a column means (fingerprint v1 → v2)
without a window where reads and writes disagree.

## Decision

- **drizzle-kit writes the SQL; `src/migrator.ts` applies it.** One transaction per migration,
  unless the file starts with `-- tripwire:no-transaction` (for `CONCURRENTLY`; every statement in
  such a file must be safe to re-run).
- **Every `NNNN_name.sql` has a hand-written `NNNN_name.down.sql`**, or the runner refuses to load.
- **Applied migrations are immutable**: the runner stores a checksum and refuses to continue if an
  applied file changed.
- **Fail fast on locks**: `lock_timeout = 10s`, so DDL that can't get its lock fails instead of
  queueing every write behind it.
- **Breaking changes go expand → migrate → contract**, each step deployable and reversible on its
  own, with flags between them. `alerts.fingerprint_v2` is the worked example: add the nullable
  column (0002), build its index concurrently (0003), dual-write (`FINGERPRINT_V2_WRITE`), backfill
  in 1,000-row batches from a checkpoint, cut reads over (`FINGERPRINT_V2_READ`), then contract
  (0004: NOT NULL via `CHECK … NOT VALID`, `VALIDATE`, `SET NOT NULL`), and finally remove the flags.
- **Code ships after its migration**, and rolls back before it: Drizzle names every column in its
  INSERTs, so code built against a newer schema fails on an older one.
- **CI proves the down path**: `scripts/migration-roundtrip.sh` applies every migration, rolls all of
  them back, applies them again, and requires the same schema dump both times;
  `expand-contract.integration.test.ts` runs the fingerprint steps and the contract's rollback
  against a real Postgres.

## Options ruled out

- **Drizzle's migrator**: the single transaction rules out `CONCURRENTLY`, and there are no downs.
- **`drizzle-kit push`**: diffs and applies with no reviewed SQL and no history; fine for a
  scratch database, not for one with data.
- **A general-purpose tool** (Flyway, golang-migrate, Atlas): would work, but adds a runtime outside
  the Node toolchain to save about 300 lines of runner.

## Consequences

- We maintain the runner, and its integration tests are the only proof it works.
- A down migration restores the schema, not data: rolling back 0001 drops every table. For
  destructive changes the real rollback is a backup, and MIGRATIONS.md says so per migration.
- Breaking changes take several releases. The fingerprint change is still mid-way: its two flags
  stay on until step 8, and setting `FINGERPRINT_V2_WRITE=false` after 0004 fails ingest on purpose.
