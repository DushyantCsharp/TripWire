import { readFileSync } from 'node:fs';
import { alertText, hashingEmbedder } from '@tripwire/pipeline';
import { z } from 'zod';

// The k6 storm's alert templates (infra/load/storm-groups.json, also read by storm.js): 8
// problems, each raised by two alert rules on one service. Embedded here exactly as the worker
// embeds an Alertmanager alert, to predict what the clustering will do with them.

const groupsSchema = z.array(
  z.object({
    truth: z.string(),
    service: z.string(),
    alerts: z.array(z.object({ alertname: z.string(), summary: z.string() })).length(2),
  }),
);

export interface StormTemplate {
  readonly truth: string;
  readonly service: string;
  readonly alertname: string;
  readonly summary: string;
}

export const STORM_GROUPS_FILE = new URL('../../infra/load/storm-groups.json', import.meta.url);

export function stormTemplates(file: URL = STORM_GROUPS_FILE): StormTemplate[] {
  const groups = groupsSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  return groups.flatMap((group) =>
    group.alerts.map((alert) => ({ truth: group.truth, service: group.service, ...alert })),
  );
}

export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (const [i, x] of a.entries()) {
    const y = b[i] ?? 0;
    dot += x * y;
    aa += x * x;
    bb += y * y;
  }
  return dot / Math.sqrt(aa * bb);
}

/** Each template with its embedding, as the worker computes it (pod is volatile, so left out). */
export async function embedTemplates(templates: readonly StormTemplate[]) {
  const embedder = hashingEmbedder();
  return Promise.all(
    templates.map(async (t) => {
      const text = alertText({
        name: t.alertname,
        service: t.service,
        summary: t.summary,
        labels: { alertname: t.alertname, service: t.service, severity: 'critical', pod: 'p-1' },
      });
      const vector = await embedder.embed(text);
      if (!vector.ok) throw new Error(vector.error.message);
      return { ...t, vector: vector.value };
    }),
  );
}

/** For each problem, how alike its two rules' alerts are; and the closest two problems get. */
export async function templateSimilarity(templates: readonly StormTemplate[] = stormTemplates()) {
  const embedded = await embedTemplates(templates);
  const within = new Map<string, number>();
  let across = 0;
  for (const [i, a] of embedded.entries()) {
    for (const b of embedded.slice(i + 1)) {
      const similarity = cosine(a.vector, b.vector);
      if (a.truth === b.truth) within.set(a.truth, similarity);
      else across = Math.max(across, similarity);
    }
  }
  return { within, across };
}
