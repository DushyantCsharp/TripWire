import { clusterJobSchema, jobIds, jobOptions, type TriageJob } from '@tripwire/contracts/queues';
import {
  clusterAlert,
  getAlertForClustering,
  type Database,
  type FingerprintVersion,
} from '@tripwire/db';
import { enqueueing } from '@tripwire/telemetry';
import type { Processor, Queue } from 'bullmq';
import { FatalError, RetryableError } from '../errors.js';
import { alertText, type Embedder } from '@tripwire/pipeline';

export interface ClusterDeps {
  readonly db: Database;
  readonly embedder: Embedder;
  readonly triageQueue: Queue;
  readonly windowMs: number;
  readonly similarityThreshold: number;
  readonly fingerprintVersion: FingerprintVersion;
}

/**
 * Attaches one alert to an incident (see clusterAlert for the order of preference). Retries are
 * safe: an alert that is already attached stays put. The alert that opened an incident queues its
 * triage, again on every retry, under a deterministic job id, so a crash between can't lose it.
 */
export function clusterProcessor(deps: ClusterDeps): Processor {
  return async (job) => {
    const parsed = clusterJobSchema.safeParse(job.data);
    if (!parsed.success)
      throw new FatalError(`invalid cluster job: ${parsed.error.message}`, 'invalid_job');
    const { alertId } = parsed.data;

    const alert = await getAlertForClustering(deps.db, alertId);
    if (!alert.ok) throw new RetryableError(alert.error.message, 'database');
    if (!alert.value) throw new FatalError(`alert ${alertId} does not exist`, 'not_found');

    const embedding = await deps.embedder.embed(alertText(alert.value));
    if (!embedding.ok) throw new RetryableError(embedding.error.message, embedding.error.kind);

    const outcome = await clusterAlert(deps.db, {
      alertId,
      embedding: embedding.value,
      windowMs: deps.windowMs,
      similarityThreshold: deps.similarityThreshold,
      fingerprintVersion: deps.fingerprintVersion,
    });
    if (!outcome.ok) {
      if (outcome.error.kind === 'alert_not_found')
        throw new FatalError(outcome.error.message, 'not_found');
      throw new RetryableError(outcome.error.message, 'database');
    }

    if (outcome.value.match === 'new_incident') {
      const triage: TriageJob = {
        incidentId: outcome.value.incidentId,
        trigger: 'new_incident',
        attempts: [],
      };
      const jobId = jobIds.triage(outcome.value.incidentId);
      await enqueueing(deps.triageQueue.name, jobId, (trace) =>
        deps.triageQueue.add('triage', trace ? { ...triage, trace } : triage, {
          ...jobOptions.triage,
          jobId,
        }),
      );
    }
    return outcome.value;
  };
}
