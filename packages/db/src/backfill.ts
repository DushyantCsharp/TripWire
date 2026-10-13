import { setTimeout as sleep } from 'node:timers/promises';
import { ok, type Result } from '@tripwire/result';
import { asc, eq, gt, sql } from 'drizzle-orm';
import type { Database } from './client.js';
import { dbCall, type DatabaseError } from './errors.js';
import { fingerprintV2 } from './fingerprint.js';
import { alerts, backfillCheckpoints } from './schema.js';

/** Checkpoint row name, and the BullMQ job name on the backfill queue. */
export const FINGERPRINT_V2_BACKFILL = 'alerts.fingerprint_v2';

export interface BackfillOptions {
  /** Rows per batch; each batch is one short transaction. */
  readonly batchSize?: number;
  /** Pause between batches, so the backfill never saturates the database. */
  readonly throttleMs?: number;
  /** Stop after this many batches; the next run resumes from the checkpoint. */
  readonly maxBatches?: number;
  /** Stops between batches (BullMQ passes one when the worker shuts down). */
  readonly signal?: AbortSignal | undefined;
  readonly onBatch?: (progress: BackfillProgress) => void | Promise<void>;
}

/** Totals for this run. `completed` means the whole table is done, across all runs. */
export interface BackfillProgress {
  readonly batches: number;
  readonly rowsScanned: number;
  readonly rowsUpdated: number;
  readonly completed: boolean;
}

interface BatchResult {
  readonly scanned: number;
  readonly updated: number;
  readonly completed: boolean;
}

/**
 * Computes alerts.fingerprint_v2 for rows written before dual-write was on. Walks the table by id
 * in batches and stores the cursor in backfill_checkpoints in the same transaction as each batch,
 * so a crash or a stop resumes exactly where it left off. Safe to run concurrently with itself
 * (the checkpoint row is locked) and with dual-writing ingest (only NULL rows are updated).
 */
export async function backfillFingerprintV2(
  db: Database,
  options: BackfillOptions = {},
): Promise<Result<BackfillProgress, DatabaseError>> {
  const { batchSize = 1000, throttleMs = 100, maxBatches = Infinity, signal, onBatch } = options;
  let progress: BackfillProgress = { batches: 0, rowsScanned: 0, rowsUpdated: 0, completed: false };

  while (progress.batches < maxBatches && !signal?.aborted) {
    const batch = await dbCall(() => runBatch(db, batchSize));
    if (!batch.ok) return batch;
    progress = {
      batches: progress.batches + (batch.value.scanned > 0 ? 1 : 0),
      rowsScanned: progress.rowsScanned + batch.value.scanned,
      rowsUpdated: progress.rowsUpdated + batch.value.updated,
      completed: batch.value.completed,
    };
    await onBatch?.(progress);
    if (progress.completed) break;
    try {
      await sleep(throttleMs, undefined, { signal });
    } catch (cause) {
      if (signal?.aborted) break;
      throw cause;
    }
  }
  return ok(progress);
}

function runBatch(db: Database, batchSize: number): Promise<BatchResult> {
  return db.transaction(async (tx) => {
    // Never queue behind a long-held lock on alerts; the job retries the batch instead.
    await tx.execute(sql`SET LOCAL lock_timeout = '2s'`);
    await tx
      .insert(backfillCheckpoints)
      .values({ name: FINGERPRINT_V2_BACKFILL })
      .onConflictDoNothing();
    const [checkpoint] = await tx
      .select()
      .from(backfillCheckpoints)
      .where(eq(backfillCheckpoints.name, FINGERPRINT_V2_BACKFILL))
      .for('update');
    if (!checkpoint) throw new Error('backfill checkpoint row vanished inside its transaction');
    if (checkpoint.completedAt) return { scanned: 0, updated: 0, completed: true };

    const rows = await tx
      .select({ id: alerts.id, labels: alerts.labels })
      .from(alerts)
      .where(checkpoint.lastId ? gt(alerts.id, checkpoint.lastId) : undefined)
      .orderBy(asc(alerts.id))
      .limit(batchSize);
    const last = rows.at(-1);
    if (!last) {
      await tx
        .update(backfillCheckpoints)
        .set({ completedAt: new Date(), updatedAt: new Date() })
        .where(eq(backfillCheckpoints.name, FINGERPRINT_V2_BACKFILL));
      return { scanned: 0, updated: 0, completed: true };
    }

    const values = sql.join(
      rows.map((row) => sql`(${row.id}::uuid, ${fingerprintV2(row.labels)})`),
      sql`, `,
    );
    const updated = await tx.execute(sql`
      UPDATE ${alerts} SET ${sql.identifier('fingerprint_v2')} = v.fingerprint
      FROM (VALUES ${values}) AS v(id, fingerprint)
      WHERE ${alerts.id} = v.id AND ${alerts.fingerprintV2} IS NULL`);
    await tx
      .update(backfillCheckpoints)
      .set({
        lastId: last.id,
        rowsDone: sql`${backfillCheckpoints.rowsDone} + ${rows.length}`,
        updatedAt: new Date(),
      })
      .where(eq(backfillCheckpoints.name, FINGERPRINT_V2_BACKFILL));
    return { scanned: rows.length, updated: updated.rowCount ?? 0, completed: false };
  });
}
