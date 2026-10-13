import { baseEnv } from '@tripwire/config';
import { z } from 'zod';

export const apiEnv = baseEnv.extend({
  API_HOST: z.string().default('127.0.0.1'),
  API_PORT: z.coerce.number().int().positive().default(4000),
  REDIS_URL: z.url(),
  /** BullMQ key prefix, shared with the worker. */
  QUEUE_PREFIX: z
    .string()
    .regex(/^[a-z][a-z0-9-]*$/)
    .default('bull'),
  /** Comma-separated webhook HMAC secrets. All of them verify, so secrets can rotate. */
  WEBHOOK_SECRETS: z
    .string()
    .transform((value) =>
      value
        .split(',')
        .map((secret) => secret.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.string().min(16, 'webhook secrets need at least 16 characters')).min(1)),
  /** Ingest sheds load (503) while more than this many ingest jobs are waiting. */
  INGEST_HIGH_WATER: z.coerce.number().int().positive().default(10_000),
});

export type ApiConfig = z.output<typeof apiEnv>;
