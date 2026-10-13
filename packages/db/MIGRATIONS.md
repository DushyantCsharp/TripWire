# Migrations

`src/schema.ts` is the source of truth for the database's shape. drizzle-kit turns changes to it
into SQL in `migrations/`, and `src/migrator.ts` applies that SQL. Drizzle's own migrator isn't
used: it runs every pending migration in one transaction, so `CONCURRENTLY` can't work, and it has
no down migrations.

## Commands

| Command                 | What it does                                                                  |
| ----------------------- | ----------------------------------------------------------------------------- |
| `just db-generate`      | Writes a migration for `schema.ts` changes. Then add its `.down.sql` by hand. |
| `just db-migrate`       | Applies pending migrations. `just db-migrate --to=N` stops after N.           |
| `just db-rollback N`    | Rolls back every migration above N. `-1` rolls back everything.               |
| `just db-status`        | Lists each migration and when it was applied.                                 |
| `just db-seed`          | Replaces all data with the deterministic demo set. Refused in production.     |
| `just db-backfill`      | Runs the fingerprint_v2 backfill by hand. Normally the worker runs it.        |
| `just test-integration` | Applies every migration up, down and up again in a container, and more.       |

## Rules

- **Every migration has a rollback.** Each `NNNN_name.sql` needs `NNNN_name.down.sql`. The runner
  refuses to load without it, and the integration tests run every down migration.
- **Never edit an applied migration.** The runner records a checksum and refuses to continue if an
  applied file changes. Write a new migration instead.
- **One transaction per migration**, unless the file starts with `-- tripwire:no-transaction`.
  `CREATE/DROP INDEX CONCURRENTLY` needs that. In such a file, every statement must be safe to
  re-run, because a failure halfway leaves the earlier statements applied.
- **Don't block writes on big tables.**
  - Build indexes `CONCURRENTLY`.
  - Add NOT NULL via `CHECK … NOT VALID`, then `VALIDATE`, then `SET NOT NULL`.
  - Add columns as nullable, or with a constant default.
- **Fail fast on locks.** The migration session sets `lock_timeout = 10s`. DDL that can't get its
  lock fails instead of queueing behind a long transaction while every write queues behind it.
  Retry later.
- **Write descending index columns as `.desc().nullsFirst()`.** drizzle-kit's plain `.desc()`
  emits `DESC NULLS LAST`. That doesn't match `ORDER BY x DESC`, so Postgres sorts the rows instead
  of reading them in index order.
- **Name camelCase-with-digit columns explicitly**, e.g. `text('fingerprint_v2')`. snake_case
  casing would otherwise turn `fingerprintV2` into `fingerprint_v_2`.
- **Code ships after its migration.** A release's code expects every migration it was built with to
  be applied, because drizzle names every column in its INSERTs. So: apply the migrations, then
  deploy. When rolling back, roll back the code first, then the migrations.

## Log

### 0000_extensions

Creates the pgvector extension, which drizzle-kit can't emit.

**Rollback:** `DROP EXTENSION vector`. Only do this on a database where nothing else uses it.

### 0001_initial

Creates every table, enum and index, and two triggers that enforce the approval invariant at the
database (CLAUDE.md):

- `proposed_actions.payload` and `payload_hash` can never change after insert.
- `approvals` is append-only. The one change allowed is setting `consumed_at`, once.

A composite foreign key also means an approval can only carry the payload hash its action has.

**Rollback:** drops everything 0001 created, data included. That's fine for disposable databases.
In production, restore from a backup instead.

### 0002–0004: alerts.fingerprint_v2 (expand/contract)

**Why:** v1 fingerprints hash every label, so 500 pods failing the same way are 500 different
identities, and dedupe can't collapse the storm. v2 hashes only identity labels: every label except
the per-instance ones and `severity` (`VOLATILE_LABELS` in `src/fingerprint.ts`). The seed's storm
shows it: 3,000 alerts with 500 v1 fingerprints but one v2 fingerprint.

Do the steps in this order. Each one is safe to stop after.

| #   | Step         | How                                                                                                                                                                      | Effect on traffic                                                                               | Rollback                                                                                                                                                                          |
| --- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Expand       | Apply 0002: adds a nullable `alerts.fingerprint_v2` and creates `backfill_checkpoints`                                                                                   | Metadata change only; no table rewrite                                                          | `just db-rollback 1`, after rolling back any code that references the column. Drops the column; its values can be recomputed.                                                     |
| 2   | Index        | Apply 0003: `CREATE INDEX CONCURRENTLY` on `(fingerprint_v2, received_at DESC)`                                                                                          | Writes continue during the build                                                                | `just db-rollback 2` (drops it concurrently)                                                                                                                                      |
| 3   | Dual-write   | Deploy with `FINGERPRINT_V2_WRITE=true`. New alerts get v2.                                                                                                              | None                                                                                            | Set the flag false. Dedupe still reads v1.                                                                                                                                        |
| 4   | Backfill     | Enqueue a job named `alerts.fingerprint_v2` on the `backfill` queue, or run `just db-backfill`                                                                           | Short transactions of 1,000 rows, a 100 ms pause between them, and a 2 s lock timeout per batch | Stop the job; the v2 values it wrote are harmless. It resumes from `backfill_checkpoints`. To start over: `DELETE FROM backfill_checkpoints WHERE name = 'alerts.fingerprint_v2'` |
| 5   | Verify       | `SELECT count(*) FROM alerts WHERE fingerprint_v2 IS NULL` returns 0                                                                                                     | None                                                                                            |                                                                                                                                                                                   |
| 6   | Read cutover | Deploy with `FINGERPRINT_V2_READ=true`. Dedupe matches on v2 and its index.                                                                                              | None                                                                                            | Set the flag false                                                                                                                                                                |
| 7   | Contract     | Apply 0004. It refuses to run while any NULL remains. Then it adds a NOT VALID check, validates it, sets NOT NULL, drops the check, and drops the v1 index concurrently. | Validation scans the table but doesn't block writes. `SET NOT NULL` skips its own scan.         | `just db-rollback 3`: recreates the v1 index concurrently and drops NOT NULL. Then reads can go back to v1 (step 6).                                                              |
| 8   | Clean up     | Remove both flags from the code; ingest always writes v2                                                                                                                 | None                                                                                            | Re-add the flags                                                                                                                                                                  |

**Notes:**

- After 0004, setting `FINGERPRINT_V2_WRITE=false` makes ingest fail with a NOT NULL violation. That
  is deliberate: it is no longer a safe setting.
- If a NULL row slips in between 0004's pre-check and its validation, 0004 fails at VALIDATE and
  leaves a NOT VALID check behind. That check rejects NULLs on new rows. Turn dual-write back on,
  rerun the backfill, and apply 0004 again: its first statements remove the leftover check.
- The backfill walks rows by UUIDv7 id, which is time-ordered. A row written after the cursor passed
  it, with dual-write off, would be missed. That's why dual-write comes before the backfill, and why
  0004's pre-check exists.
- `src/expand-contract.integration.test.ts` runs steps 1 to 7 and the step 7 rollback against a real
  Postgres.

### 0005_triage_job_key

**Why:** a triage job runs again when it is retried or when its worker dies mid-job. The new
`triage_runs.job_key` (unique: the BullMQ job id) makes every attempt of one job share a single run
row, so a rerun can't write a second report. `attempts` counts how often the job started. Three
failure reasons are added for the worker's error classes: `invalid_output`, `request_rejected` and
`internal_error`.

All additive. The unique constraint builds its index under a brief exclusive lock, which is fine
for `triage_runs` (one row per triage job). The new enum values aren't used in the same transaction
that adds them.

**Rollback:** `just db-rollback 4`. Roll back the worker first, because the current worker writes
`job_key`. This drops the constraint and both columns, relabels runs that failed for one of the new
reasons as `model_unavailable`, and rebuilds the enum without them (Postgres can't drop enum values).

### 0006_runbooks_partial_reports

**Why:** the triage loop's tools and reports. `runbook_chunks` holds the sections of `/runbooks`,
embedded, for `get_runbook`'s pgvector search. `triage_runs.stop_reason` records why a run ended:
anything but `report_submitted` means a limit was breached and the report is partial.
`hypotheses.fault_class` records the kind of failure each hypothesis blames. The partial unique
index keeps one pending proposal per incident and payload, so a redriven triage that proposes the
same action again doesn't duplicate it.

All additive: two new types, a new table, two nullable columns, and a unique index on
`proposed_actions`. Nothing wrote proposals before this release, so the index builds at once inside
the migration's transaction.

**Rollback:** `just db-rollback 5`. Roll back the worker first: it writes the columns, the chunks and
proposals. This drops the index, both columns, the table and both types. After re-applying, run
`just runbooks-index` to fill `runbook_chunks` again.
