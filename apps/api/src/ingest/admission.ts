import type { Queue } from 'bullmq';
import type { AdmissionControl } from './ports.js';

export interface QueueStats {
  waiting(): Promise<number>;
  /** Jobs finished (completed or failed) since metrics began; its slope is the drain rate. */
  finished(): Promise<number>;
}

/** Reads the ingest queue; the worker records the metrics this needs (MetricsTime.ONE_WEEK). */
export function bullmqQueueStats(queue: Queue): QueueStats {
  return {
    waiting: () => queue.getWaitingCount(),
    finished: async () => {
      const [completed, failed] = await Promise.all([
        queue.getMetrics('completed', 0, 0),
        queue.getMetrics('failed', 0, 0),
      ]);
      return completed.meta.count + failed.meta.count;
    },
  };
}

export interface AdmissionOptions {
  readonly highWater: number;
  readonly sampleEveryMs?: number;
  /** How far back the drain rate is measured. */
  readonly windowMs?: number;
  readonly maxRetryAfterSeconds?: number;
  readonly now?: () => number;
  readonly random?: () => number;
  readonly onError?: (error: unknown) => void;
}

/**
 * Admission control on ingest queue depth. A background sampler reads the queue, so a request
 * costs no Redis round trip. Retry-After is the time to drain back to the high-water mark at the
 * measured rate, plus up to 25% jitter so shed senders don't all come back at once.
 */
export class QueueDepthAdmission implements AdmissionControl {
  private waiting = 0;
  private samples: { at: number; finished: number }[] = [];
  private failing = false;
  private timer: NodeJS.Timeout | undefined;
  private readonly options: Required<AdmissionOptions>;

  constructor(
    private readonly stats: QueueStats,
    options: AdmissionOptions,
  ) {
    this.options = {
      sampleEveryMs: 250,
      windowMs: 10_000,
      maxRetryAfterSeconds: 60,
      now: Date.now,
      random: Math.random,
      onError: () => undefined,
      ...options,
    };
  }

  start(): void {
    void this.sample();
    this.timer = setInterval(() => void this.sample(), this.options.sampleEveryMs).unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  async sample(): Promise<void> {
    try {
      const [waiting, finished] = await Promise.all([this.stats.waiting(), this.stats.finished()]);
      const at = this.options.now();
      this.waiting = waiting;
      this.samples = [
        ...this.samples.filter((s) => s.at >= at - this.options.windowMs),
        { at, finished },
      ];
      this.failing = false;
    } catch (error) {
      // Keep deciding on the last known depth. Report the first failure of a run, not every sample.
      if (!this.failing) this.options.onError(error);
      this.failing = true;
    }
  }

  check(): { retryAfterSeconds: number } | null {
    if (this.waiting <= this.options.highWater) return null;
    return { retryAfterSeconds: this.retryAfterSeconds() };
  }

  private retryAfterSeconds(): number {
    const { maxRetryAfterSeconds, highWater, random } = this.options;
    const first = this.samples[0];
    const last = this.samples.at(-1);
    const elapsed = first && last ? (last.at - first.at) / 1000 : 0;
    const perSecond = first && last && elapsed > 0 ? (last.finished - first.finished) / elapsed : 0;
    const seconds = perSecond > 0 ? (this.waiting - highWater) / perSecond : maxRetryAfterSeconds;
    return Math.min(maxRetryAfterSeconds, Math.max(1, Math.ceil(seconds * (1 + random() * 0.25))));
  }
}
