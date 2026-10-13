import { baseEnv } from '@tripwire/config';
import { z } from 'zod';

const positiveInt = (fallback: number) => z.coerce.number().int().positive().default(fallback);

export const workerEnv = baseEnv
  .extend({
    REDIS_URL: z.url(),
    DATABASE_URL: z.url(),
    /** BullMQ key prefix, shared with the API. The chaos test uses its own to stay isolated. */
    QUEUE_PREFIX: z
      .string()
      .regex(/^[a-z][a-z0-9-]*$/)
      .default('bull'),

    // alerts.fingerprint_v2 expand/contract flags (packages/db/MIGRATIONS.md): ingest dual-writes v2
    // when WRITE is on; clustering dedupes on v2 when READ is on. Both stay on once 0004 is applied.
    FINGERPRINT_V2_WRITE: z.stringbool().default(true),
    FINGERPRINT_V2_READ: z.stringbool().default(true),

    INGEST_CONCURRENCY: positiveInt(8),
    CLUSTER_CONCURRENCY: positiveInt(8),
    /** How long an open incident keeps attracting new alerts. */
    CLUSTER_WINDOW_MINUTES: z.coerce.number().positive().default(10),
    /** Cosine similarity an alert must exceed to join an open incident with another fingerprint. */
    CLUSTER_SIMILARITY_THRESHOLD: z.coerce.number().min(0).max(1).default(0.85),

    TRIAGE_CONCURRENCY: positiveInt(4),
    /** BullMQ rate limiter: keeps us under the model provider's limit, so it never has to be. */
    TRIAGE_MAX_PER_MINUTE: positiveInt(30),
    TRIAGE_BACKOFF_BASE_MS: positiveInt(2_000),
    TRIAGE_BACKOFF_CAP_MS: positiveInt(60_000),
    TRIAGE_MAX_INPUT_TOKENS: positiveInt(40_000),
    TRIAGE_MAX_OUTPUT_TOKENS: positiveInt(4_000),
    TRIAGE_MAX_TOOL_CALLS: positiveInt(8),
    /** A triage run's wall-clock limit: past it, the run ends with a partial report. */
    TRIAGE_WALL_CLOCK_MS: positiveInt(60_000),
    /** Baseline triager only: simulated thinking time, for shutdown and chaos testing. */
    TRIAGE_SIMULATED_LATENCY_MS: z.coerce.number().int().min(0).default(0),

    /**
     * Which triager runs: `claude` (the tool-use loop; needs ANTHROPIC_API_KEY) or `baseline` (no
     * model: ranks services by alert labels). Explicit, so a key in .env never turns on spending.
     */
    TRIAGER: z.enum(['claude', 'baseline']).default('baseline'),
    ANTHROPIC_API_KEY: z.string().min(1).optional(),
    TRIAGE_MODEL: z.string().min(1).default('claude-opus-5-5'),
    /** Thinking depth. Thinking is output, and a run has 4k output tokens. */
    TRIAGE_EFFORT: z.enum(['low', 'medium', 'high']).default('low'),
    // The telemetry the tools read. A tool whose backend isn't configured answers "unavailable",
    // except list_deploys, which isn't offered without a change feed.
    /** OpenSearch holding OpenTelemetry logs (the OTel demo's: http://localhost:29200). */
    LOGS_OPENSEARCH_URL: z.url().optional(),
    /** Jaeger's query API, base path included (the demo's: http://localhost:26686/jaeger/ui). */
    TRACES_JAEGER_URL: z.url().optional(),
    /** Prometheus (the demo's: http://localhost:9090). */
    METRICS_PROMETHEUS_URL: z.url().optional(),
    /** A change feed answering GET ?since&until&service (see @tripwire/agent httpChangeSource). */
    DEPLOYS_URL: z.url().optional(),
    /** Where `runbooks:index` reads the runbooks from. */
    RUNBOOKS_DIR: z.string().min(1).default('../../runbooks'),

    /**
     * How long SIGTERM waits for in-flight jobs before cancelling them and exiting. Longer than a
     * triage run's wall clock, so a deploy doesn't cancel runs (and repeat their model spend).
     */
    SHUTDOWN_TIMEOUT_MS: positiveInt(75_000),
    /** Job lock, and how often stalled jobs are checked: a dead worker's job is retried after this. */
    JOB_LOCK_MS: positiveInt(30_000),
    /** Stalls tolerated before a job fails. A job that keeps killing its worker is a poison message. */
    MAX_STALLED_COUNT: positiveInt(3),
  })
  .refine((env) => env.TRIAGER !== 'claude' || env.ANTHROPIC_API_KEY !== undefined, {
    path: ['ANTHROPIC_API_KEY'],
    message: 'TRIAGER=claude needs ANTHROPIC_API_KEY',
  });

export type WorkerConfig = z.output<typeof workerEnv>;
