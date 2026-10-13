import { ok } from '@tripwire/result';
import { z } from 'zod';
import type { ChangeSource } from '../tools/ports.js';
import { type BackendOptions, requestJson } from './http.js';

// Deploys and config changes from any feed that answers
//   GET <url>?since=<ISO 8601>&until=<ISO 8601>[&service=<name>]
// with { "changes": [{ "id", "service", "kind": "deploy" | "config", "description", "at" }] }.
// A CD system or a small adapter in front of one can serve it.

const changesResponse = z.object({
  changes: z.array(
    z.object({
      id: z.string().min(1),
      service: z.string().min(1),
      kind: z.enum(['deploy', 'config']),
      description: z.string(),
      at: z.iso.datetime({ offset: true }),
    }),
  ),
});

export function httpChangeSource(options: BackendOptions): ChangeSource {
  return {
    async list(query, { signal }) {
      const url = new URL(options.url);
      url.searchParams.set('since', query.from.toISOString());
      url.searchParams.set('until', query.to.toISOString());
      if (query.service !== undefined) url.searchParams.set('service', query.service);
      const response = await requestJson({
        backend: 'the change feed',
        url,
        schema: changesResponse,
        signal,
        fetch: options.fetch,
      });
      if (!response.ok) return response;
      return ok(response.value.changes.map((change) => ({ ...change, at: new Date(change.at) })));
    },
  };
}
