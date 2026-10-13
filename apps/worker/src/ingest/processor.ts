import { ingestJobSchema, jobIds, jobOptions } from '@tripwire/contracts/queues';
import { alertIdsForIngest, recordIngest, type Database } from '@tripwire/db';
import { enqueueingMany } from '@tripwire/telemetry';
import type { Processor, Queue } from 'bullmq';
import { FatalError, RetryableError } from '../errors.js';
import { normalizeAlerts } from '@tripwire/pipeline';

export interface IngestDeps {
  readonly db: Database;
  readonly clusterQueue: Queue;
  /** The fingerprint_v2 dual-write flag. */
  readonly writeFingerprintV2: boolean;
}

/**
 * Persists a delivery and queues one cluster job per alert. Postgres's unique idempotency key is
 * the backstop behind the API's Redis check: a repeated delivery writes nothing, but its cluster
 * jobs are queued again (deterministic ids make that a no-op), in case a crash came between.
 */
export function ingestProcessor({ db, clusterQueue, writeFingerprintV2 }: IngestDeps): Processor {
  return async (job) => {
    const parsed = ingestJobSchema.safeParse(job.data);
    if (!parsed.success)
      throw new FatalError(`invalid ingest job: ${parsed.error.message}`, 'invalid_job');
    const data = parsed.data;
    const alerts = normalizeAlerts(data.source, data.payload);
    if (!alerts.ok) throw new FatalError(alerts.error.message, 'invalid_job');

    const recorded = await recordIngest(
      db,
      {
        id: data.ingestId,
        idempotencyKey: data.idempotencyKey,
        bodyHash: data.bodyHash,
        source: data.source,
        receivedAt: new Date(data.receivedAt),
        alerts: alerts.value,
      },
      { writeFingerprintV2 },
    );
    if (!recorded.ok) throw new RetryableError(recorded.error.message, 'database');

    let alertIds: readonly string[];
    if (recorded.value.status === 'recorded') {
      alertIds = recorded.value.alertIds;
    } else {
      if (!recorded.value.bodyHashMatches) {
        throw new FatalError(
          `idempotency key ${data.idempotencyKey} was recorded with a different body`,
          'invalid_job',
        );
      }
      const existing = await alertIdsForIngest(db, recorded.value.ingestId);
      if (!existing.ok) throw new RetryableError(existing.error.message, 'database');
      alertIds = existing.value;
    }

    // One `send cluster` span per alert, each carried in its job: the delivery's trace fans out.
    await enqueueingMany(clusterQueue.name, alertIds.map(jobIds.cluster), (traces) =>
      clusterQueue.addBulk(
        alertIds.map((alertId, index) => {
          const trace = traces[index];
          return {
            name: 'cluster',
            data: trace ? { alertId, trace } : { alertId },
            opts: { ...jobOptions.cluster, jobId: jobIds.cluster(alertId) },
          };
        }),
      ),
    );
    return {
      ingestId: recorded.value.ingestId,
      alerts: alertIds.length,
      duplicate: recorded.value.status === 'duplicate',
    };
  };
}
