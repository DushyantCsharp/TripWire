import { err, ok, type Result } from '@tripwire/result';
import type { z } from 'zod';
import type { ToolError } from '../tools/ports.js';

// The I/O edge for telemetry backends: every failure becomes a ToolError value. A backend that is
// down, slow or answering 5xx is `unavailable` (the evidence is missing); one that rejects the
// query with a 4xx is `invalid_query` (the model can fix it). Responses are parsed with zod.

export interface BackendOptions {
  /** Base URL of the backend's HTTP API. */
  readonly url: string;
  /** Replaces global fetch, for tests. */
  readonly fetch?: typeof fetch | undefined;
}

export interface JsonRequest<T> {
  /** Names the backend in messages, e.g. "Prometheus". */
  readonly backend: string;
  readonly url: URL;
  readonly method?: 'GET' | 'POST';
  readonly body?: unknown;
  readonly schema: z.ZodType<T>;
  /** Pulls the backend's own explanation out of an error response body. */
  readonly describeError?: ((body: unknown) => string | undefined) | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly fetch?: typeof fetch | undefined;
}

export async function requestJson<T>(request: JsonRequest<T>): Promise<Result<T, ToolError>> {
  const { backend, signal } = request;
  let response: Response;
  try {
    response = await (request.fetch ?? fetch)(request.url, {
      method: request.method ?? 'GET',
      headers:
        request.body === undefined
          ? { accept: 'application/json' }
          : { accept: 'application/json', 'content-type': 'application/json' },
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
      signal,
    });
  } catch (cause) {
    if (signal?.aborted) return err({ kind: 'unavailable', message: `${backend} timed out` });
    const reason = cause instanceof Error ? cause.message : String(cause);
    return err({ kind: 'unavailable', message: `${backend} is unreachable: ${reason}` });
  }

  let body: unknown;
  try {
    const text = await response.text();
    body = text === '' ? null : JSON.parse(text);
  } catch (cause) {
    if (signal?.aborted) return err({ kind: 'unavailable', message: `${backend} timed out` });
    if (!response.ok) return err(statusError(backend, response.status, undefined));
    const reason = cause instanceof Error ? cause.message : String(cause);
    return err({
      kind: 'unavailable',
      message: `${backend} sent a response that isn't JSON: ${reason}`,
    });
  }

  if (!response.ok) {
    return err(statusError(backend, response.status, request.describeError?.(body)));
  }
  const parsed = request.schema.safeParse(body);
  if (!parsed.success) {
    return err({
      kind: 'unavailable',
      message: `${backend} sent a response in an unexpected shape`,
    });
  }
  return ok(parsed.data);
}

function statusError(backend: string, status: number, detail: string | undefined): ToolError {
  const message = `${backend} answered ${String(status)}${detail ? `: ${detail}` : ''}`;
  // 429 and 5xx: the backend is struggling, not the query. 408 is a timeout.
  if (status >= 500 || status === 429 || status === 408) return { kind: 'unavailable', message };
  return { kind: 'invalid_query', message };
}
