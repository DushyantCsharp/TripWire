import { err, ok, type Result } from '@tripwire/result';
import { z } from 'zod';

export interface InvalidEnv {
  readonly kind: 'invalid_env';
  /** One line per offending variable, e.g. "DATABASE_URL: Invalid URL". */
  readonly issues: readonly string[];
}

/** Variables every process reads. Apps `.extend()` this with their own. */
export const baseEnv = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export function parseEnv<S extends z.ZodType>(
  schema: S,
  source: NodeJS.ProcessEnv = process.env,
): Result<z.output<S>, InvalidEnv> {
  const parsed = schema.safeParse(source);
  if (parsed.success) return ok(parsed.data);
  return err({
    kind: 'invalid_env',
    issues: parsed.error.issues.map(
      (issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`,
    ),
  });
}

/** For process entrypoints: bad config is fatal, so report every issue and exit. */
export function loadEnvOrExit<S extends z.ZodType>(schema: S): z.output<S> {
  const result = parseEnv(schema);
  if (result.ok) return result.value;
  process.stderr.write(
    `Invalid environment:\n${result.error.issues.map((issue) => `  - ${issue}`).join('\n')}\n`,
  );
  process.exit(1);
}
