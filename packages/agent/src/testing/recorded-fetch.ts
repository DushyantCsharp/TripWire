// Record/replay for model calls: tests run the real client stack against recorded HTTP exchanges,
// so they are deterministic and free. A recording is keyed by a hash of its request (method, path,
// and canonical JSON body, never headers), so any change to the prompt, tools or conversation is a
// miss rather than a silently wrong answer.
//
// Re-record from the API (writes over the scenario's directory; review the diff):
//   RECORD_LLM=1 ANTHROPIC_API_KEY=… pnpm --filter @tripwire/agent test
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from '@tripwire/config';
import { z } from 'zod';
import { anthropicModelClient } from '../anthropic.js';
import { canonicalHash } from '../canonical.js';
import type { ModelClient } from '../model.js';

const recordedRequest = z.object({ method: z.string(), path: z.string(), body: z.unknown() });

const recording = z.object({
  key: z.string().regex(/^[0-9a-f]{64}$/),
  /** 'api' when recorded from the provider; anything else says where it came from. */
  source: z.string().min(1),
  request: recordedRequest,
  response: z.object({
    status: z.number().int(),
    headers: z.record(z.string(), z.string()),
    body: z.unknown(),
  }),
});

export type Recording = z.output<typeof recording>;
export type RecordedRequest = z.output<typeof recordedRequest>;

/** Response headers the client reads. Nothing else is kept: no ids, no account rate limits. */
const KEPT_HEADERS = ['content-type', 'retry-after', 'retry-after-ms'];

export interface RecordedFetch {
  readonly fetch: typeof fetch;
  /** Exchanges served so far, in order. */
  readonly served: readonly Recording[];
  /** Keys of requests that had no recording. Each one also failed its fetch. */
  readonly missing: readonly string[];
  /** Recordings in the directory that no request has used. */
  unused(): string[];
}

export function requestKey(request: RecordedRequest): string {
  return canonicalHash(request);
}

/** Serves recordings from `dir`. A request without one fails, naming its key. */
export function replayFetch(dir: string): RecordedFetch {
  const recordings = new Map(
    readdirSync(dir)
      .filter((file) => file.endsWith('.json'))
      .map((file) => recording.parse(JSON.parse(readFileSync(join(dir, file), 'utf8'))))
      .map((entry) => [entry.key, entry]),
  );
  const served: Recording[] = [];
  const missing: string[] = [];
  return {
    served,
    missing,
    unused: () => [...recordings.keys()].filter((key) => !served.some((s) => s.key === key)),
    async fetch(input, init) {
      init?.signal?.throwIfAborted();
      const request = await describe(input, init);
      const key = requestKey(request);
      const entry = recordings.get(key);
      if (!entry) {
        missing.push(key);
        throw new Error(
          `no recording of ${request.method} ${request.path} (request ${key}) in ${dir}: the ` +
            'request changed, so re-record it (see recorded-fetch.ts)',
        );
      }
      served.push(entry);
      const { status, headers, body } = entry.response;
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        headers,
      });
    },
  };
}

/** Passes requests to `upstream` and writes each exchange to `dir`, which it empties first. */
export function recordFetch(dir: string, upstream: typeof fetch, source = 'api'): RecordedFetch {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const served: Recording[] = [];
  return {
    served,
    missing: [],
    unused: () => [],
    async fetch(input, init) {
      const request = await describe(input, init);
      const response = await upstream(input, init);
      const text = await response.text();
      const entry: Recording = {
        key: requestKey(request),
        source,
        request,
        response: {
          status: response.status,
          headers: Object.fromEntries(
            KEPT_HEADERS.flatMap((name) => {
              const value = response.headers.get(name);
              return value === null ? [] : [[name, value]];
            }),
          ),
          body: parseJson(text),
        },
      };
      writeFileSync(join(dir, `${entry.key}.json`), `${JSON.stringify(entry, null, 2)}\n`);
      served.push(entry);
      return new Response(text, { status: response.status, headers: response.headers });
    },
  };
}

const recordingEnv = z.object({
  RECORD_LLM: z.stringbool().default(false),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
});

/**
 * An Anthropic ModelClient over the recordings in `dir`: replayed by default, recorded from the API
 * with RECORD_LLM=1 and ANTHROPIC_API_KEY set.
 */
export function recordedModel(dir: string): { client: ModelClient; recorder: RecordedFetch } {
  const env = parseEnv(recordingEnv);
  if (!env.ok) throw new Error(env.error.issues.join('; '));
  if (!env.value.RECORD_LLM) {
    const recorder = replayFetch(dir);
    return { recorder, client: anthropicModelClient({ apiKey: 'replay', fetch: recorder.fetch }) };
  }
  const apiKey = env.value.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('RECORD_LLM=1 records from the API, so it needs ANTHROPIC_API_KEY');
  const recorder = recordFetch(dir, globalThis.fetch);
  return { recorder, client: anthropicModelClient({ apiKey, fetch: recorder.fetch }) };
}

async function describe(input: string | URL | Request, init?: RequestInit) {
  const request = new Request(input, init);
  const url = new URL(request.url);
  return {
    method: request.method,
    path: url.pathname + url.search,
    body: parseJson(await request.text()),
  };
}

function parseJson(text: string): unknown {
  if (text === '') return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // Not JSON (a proxy's HTML error page, say): keep it verbatim.
    return text;
  }
}
