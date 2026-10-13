import { err, ok, type Result } from '@tripwire/result';
import { z } from 'zod';
import { strictJsonSchema } from './json-schema.js';
import { FAULT_CLASSES } from './triage.js';

// The model's final answer: JSON text matching reportSchema. The API constrains the text to the
// strict form of the schema (structured output); zod then checks everything strict mode can't
// express (lengths, ranges, counts).

export const reportSchema = z.strictObject({
  summary: z
    .string()
    .min(1)
    .max(600)
    .describe(
      'Two or three sentences for the on-call engineer: the likely cause and what showed it.',
    ),
  hypotheses: z
    .array(
      z.strictObject({
        title: z.string().min(1).max(160),
        explanation: z.string().min(1).max(500),
        confidence: z.number().min(0).max(1).describe('How likely this is the root cause, 0–1.'),
        suspect: z
          .string()
          .min(1)
          .max(100)
          .nullable()
          .describe('The service at fault, named as the tools name it, or null if unknown.'),
        faultClass: z.enum(FAULT_CLASSES),
        evidence: z
          .array(z.string().min(1).max(300))
          .max(6)
          .describe('Ids of records that tools returned which support this hypothesis.'),
      }),
    )
    .min(1)
    .max(3)
    .describe('One to three root-cause hypotheses, most likely first.'),
});

export type ReportInput = z.output<typeof reportSchema>;

/** The JSON Schema the API constrains the final answer to. */
export const REPORT_OUTPUT_SCHEMA = strictJsonSchema(reportSchema);

/**
 * Parses the model's answer. The error is a short list of what's wrong, by JSON path, to send back
 * in the repair turn (capped: it's re-sent with the whole conversation).
 */
export function parseReport(text: string): Result<ReportInput, string> {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return err(`not valid JSON (${String(text.length)} characters, possibly cut off)`);
  }
  const parsed = reportSchema.safeParse(json);
  if (parsed.success) return ok(parsed.data);
  const issues = parsed.error.issues.map(
    (issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`,
  );
  return err(truncate(issues.join('; '), 1_000));
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
