// In-memory stand-ins for Redis and BullMQ, for route tests that don't need real infrastructure.
import type { IngestJob } from '@tripwire/contracts/queues';
import { err, ok } from '@tripwire/result';
import type { DeadLetter, DeadLetters } from '../dead-letters.js';
import type {
  AdmissionControl,
  DependencyError,
  IdempotencyRecord,
  IdempotencyStore,
  IngestQueue,
} from '../ingest/ports.js';

const down: DependencyError = { kind: 'dependency_unavailable', message: 'connection refused' };

export function memoryIdempotency() {
  const records = new Map<string, IdempotencyRecord>();
  const store: IdempotencyStore & { records: typeof records; down: boolean } = {
    records,
    down: false,
    claim(key, record) {
      if (store.down) return Promise.resolve(err(down));
      const existing = records.get(key);
      if (existing) return Promise.resolve(ok({ claimed: false as const, existing }));
      records.set(key, record);
      return Promise.resolve(ok({ claimed: true as const }));
    },
    release(key) {
      records.delete(key);
      return Promise.resolve(ok(undefined));
    },
  };
  return store;
}

export function memoryQueue() {
  const queue: IngestQueue & { jobs: IngestJob[]; down: boolean } = {
    jobs: [],
    down: false,
    enqueue(job) {
      if (queue.down) return Promise.resolve(err(down));
      queue.jobs.push(job);
      return Promise.resolve(ok(undefined));
    },
  };
  return queue;
}

export function switchableAdmission() {
  const admission: AdmissionControl & { shedFor: number | null } = {
    shedFor: null,
    check: () => (admission.shedFor === null ? null : { retryAfterSeconds: admission.shedFor }),
  };
  return admission;
}

export function memoryDeadLetters(entries: DeadLetter[]) {
  const deadLetters: DeadLetters & { entries: DeadLetter[]; down: boolean } = {
    entries,
    down: false,
    list(limit) {
      if (deadLetters.down) return Promise.resolve(err(down));
      return Promise.resolve(ok(deadLetters.entries.slice(0, limit)));
    },
    redrive(id) {
      if (deadLetters.down) return Promise.resolve(err(down));
      const entry = deadLetters.entries.find((candidate) => candidate.id === id);
      if (!entry) return Promise.resolve(err({ kind: 'not_found' as const }));
      deadLetters.entries = deadLetters.entries.filter((candidate) => candidate !== entry);
      return Promise.resolve(ok({ jobId: `redrive-${id}`, incidentId: entry.job.incidentId }));
    },
  };
  return deadLetters;
}
