import type { TriageBudget, Triager } from '@tripwire/agent';
import { triageJobSchema, type TriageAttempt } from '@tripwire/contracts/queues';
import {
  beginTriageRun,
  completeTriageRun,
  loadIncidentForTriage,
  type Database,
} from '@tripwire/db';
import type { Job, Processor, Queue } from 'bullmq';
import { FatalError, RetryableError, toJobError } from '../errors.js';
import { deadLetterTriage, isFinalFailure } from './dead-letter.js';

export interface TriageDeps {
  readonly db: Database;
  readonly triager: Triager;
  readonly deadLetterQueue: Queue;
  readonly budget: TriageBudget;
}

/**
 * Triages one incident. Every attempt of a job shares one triage_runs row (keyed by job id), and the
 * report commits in the same transaction that marks the run succeeded, so redeliveries and retries
 * never write a second report. Failures append to the job's attempt history; the last one moves
 * the job to the dead-letter queue.
 */
export function triageProcessor(deps: TriageDeps): Processor {
  return async (job, _token, signal) => {
    try {
      return await triage(deps, job, signal);
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      const parsed = triageJobSchema.safeParse(job.data);
      const attempt: TriageAttempt = {
        attempt: job.attemptsMade + 1,
        errorClass: error.name,
        message: error.message,
        at: new Date().toISOString(),
      };
      const attempts = [...(parsed.success ? parsed.data.attempts : []), attempt];
      if (parsed.success) await job.updateData({ ...parsed.data, attempts });
      if (isFinalFailure(error, job.attemptsMade + 1, job)) {
        await deadLetterTriage(deps, job, error, attempts);
      }
      throw error;
    }
  };
}

async function triage(
  { db, triager, budget }: TriageDeps,
  job: Job,
  signal: AbortSignal | undefined,
) {
  const parsed = triageJobSchema.safeParse(job.data);
  if (!parsed.success)
    throw new FatalError(`invalid triage job: ${parsed.error.message}`, 'invalid_job');
  if (job.id === undefined) throw new Error('BullMQ delivered a job without an id');
  const { incidentId } = parsed.data;

  const run = await beginTriageRun(db, { incidentId, jobKey: job.id, model: triager.model });
  if (!run.ok) throw new RetryableError(run.error.message, 'database');
  if (run.value.status === 'already_succeeded')
    return { triageRunId: run.value.runId, skipped: true };

  const incident = await loadIncidentForTriage(db, incidentId);
  if (!incident.ok) throw new RetryableError(incident.error.message, 'database');
  if (!incident.value) throw new FatalError(`incident ${incidentId} does not exist`, 'not_found');

  // The job id keys the run across retries: proposals derive their ids from it, so a retried
  // attempt proposes the same rows. A report cut short by a limit is still a report: it's stored
  // with its stop reason, not retried (a retry would hit the same limit, at the same cost).
  const report = await triager.triage(
    { ...incident.value, incidentId: incident.value.id },
    { budget, runKey: job.id, signal },
  );
  if (!report.ok) throw toJobError(report.error);

  const completed = await completeTriageRun(db, run.value.runId, report.value);
  if (!completed.ok) throw new RetryableError(completed.error.message, 'database');
  return {
    triageRunId: run.value.runId,
    written: completed.value.written,
    stopReason: report.value.stopReason,
  };
}
