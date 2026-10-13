import {
  jobIds,
  jobOptions,
  triageDeadLetterSchema,
  type TriageDeadLetter,
  type TriageJob,
} from '@tripwire/contracts/queues';
import { attempt, err, ok, type Result } from '@tripwire/result';
import type { Queue } from 'bullmq';
import type { DependencyError } from './ingest/ports.js';

export interface DeadLetter extends TriageDeadLetter {
  readonly id: string;
}

export interface DeadLetters {
  /** Newest first. */
  list(limit: number): Promise<Result<DeadLetter[], DependencyError>>;
  /**
   * Re-enqueues the entry as a fresh triage job with a full set of attempts, then removes it.
   * Idempotent: the new job's id derives from the entry's, so a repeated redrive can't double it.
   */
  redrive(
    id: string,
  ): Promise<
    Result<{ jobId: string; incidentId: string }, DependencyError | { readonly kind: 'not_found' }>
  >;
}

const unavailable = (cause: unknown): DependencyError => ({
  kind: 'dependency_unavailable',
  message: cause instanceof Error ? cause.message : String(cause),
});

export function bullmqDeadLetters(deadLetterQueue: Queue, triageQueue: Queue): DeadLetters {
  return {
    async list(limit) {
      const jobs = await attempt(
        () => deadLetterQueue.getJobs(['waiting'], 0, limit - 1),
        unavailable,
      );
      if (!jobs.ok) return jobs;
      return ok(
        jobs.value
          .flatMap((job) => {
            const parsed = triageDeadLetterSchema.safeParse(job.data);
            return parsed.success && job.id !== undefined ? [{ ...parsed.data, id: job.id }] : [];
          })
          .sort((a, b) => b.failedAt.localeCompare(a.failedAt)),
      );
    },

    async redrive(id) {
      const found = await attempt(() => deadLetterQueue.getJob(id), unavailable);
      if (!found.ok) return found;
      const parsed = triageDeadLetterSchema.safeParse(found.value?.data);
      if (!parsed.success) return err({ kind: 'not_found' as const });

      const jobId = jobIds.redrive(id);
      const job: TriageJob = {
        incidentId: parsed.data.job.incidentId,
        trigger: 'redrive',
        redrivenFrom: id,
        attempts: [],
      };
      const moved = await attempt(async () => {
        await triageQueue.add('triage', job, { ...jobOptions.triage, jobId });
        await deadLetterQueue.remove(id);
      }, unavailable);
      if (!moved.ok) return moved;
      return ok({ jobId, incidentId: job.incidentId });
    },
  };
}
