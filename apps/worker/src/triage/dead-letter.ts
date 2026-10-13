import {
  jobIds,
  triageJobSchema,
  type TriageAttempt,
  type TriageDeadLetter,
} from '@tripwire/contracts/queues';
import { failTriageRun, type Database } from '@tripwire/db';
import { type Job, type Queue, UnrecoverableError } from 'bullmq';
import { failureReason } from '../errors.js';

export interface DeadLetterDeps {
  readonly db: Database;
  readonly deadLetterQueue: Queue;
}

/** Whether a failure is the job's last: unrecoverable, or out of attempts. */
export function isFinalFailure(error: Error, attemptsMade: number, job: Job): boolean {
  return error instanceof UnrecoverableError || attemptsMade >= (job.opts.attempts ?? 1);
}

/**
 * Parks a triage job that failed for good on the dead-letter queue, with its error class, attempt
 * history and last stack, and marks its run failed. Idempotent: the entry's id derives from the
 * job's, because both the processor and the worker's 'failed' event may call this. Skips a job
 * whose run succeeded after all.
 */
export async function deadLetterTriage(
  { db, deadLetterQueue }: DeadLetterDeps,
  job: Job,
  error: Error,
  attempts: readonly TriageAttempt[],
): Promise<'dead_lettered' | 'already_succeeded' | 'invalid_job'> {
  const parsed = triageJobSchema.safeParse(job.data);
  const jobId = job.id;
  // Without a valid payload there is nothing to redrive; the job stays in BullMQ's failed set.
  if (!parsed.success || jobId === undefined) return 'invalid_job';

  // First, because it tells us whether the job's report committed after all: a worker that lost its
  // lock can finish the work while BullMQ fails the job as stalled. Then there's nothing to redrive,
  // and a redrive would write a second report.
  const marked = await failTriageRun(db, {
    jobKey: jobId,
    reason: failureReason(error),
    error: error.message,
  });
  if (!marked.ok) {
    throw new Error(
      `could not mark run ${jobId} failed before dead-lettering: ${marked.error.message}`,
    );
  }
  if (marked.value.outcome === 'already_succeeded') return 'already_succeeded';

  const entry: TriageDeadLetter = {
    jobId,
    job: { ...parsed.data, attempts: [...attempts] },
    errorClass: error.name,
    failedReason: error.message,
    lastStack: error.stack ?? job.stacktrace?.at(-1) ?? null,
    attempts: [...attempts],
    failedAt: new Date().toISOString(),
  };
  await deadLetterQueue.add('triage-dead-letter', entry, { jobId: jobIds.deadLetter(jobId) });
  return 'dead_lettered';
}
