import { backfillFingerprintV2, FINGERPRINT_V2_BACKFILL, type Database } from '@tripwire/db';
import { type Processor, UnrecoverableError } from 'bullmq';

/** Runs backfill jobs by name. Every run resumes from its checkpoint, so retries are safe. */
export function backfillProcessor(db: Database): Processor {
  return async (job, _token, signal) => {
    if (job.name !== FINGERPRINT_V2_BACKFILL) {
      throw new UnrecoverableError(`unknown backfill job "${job.name}"`);
    }
    const result = await backfillFingerprintV2(db, {
      signal,
      onBatch: (progress) => job.updateProgress({ ...progress }),
    });
    // Retryable: BullMQ backs off, and the next attempt resumes from the checkpoint.
    if (!result.ok) throw new Error(`fingerprint_v2 backfill failed: ${result.error.message}`);
    return result.value;
  };
}
