import Anthropic, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from '@anthropic-ai/sdk';
import { attempt, ok } from '@tripwire/result';
import type {
  ModelBlock,
  ModelClient,
  ModelRequest,
  ModelResponse,
  ResponseBlock,
  ModelStopReason,
} from './model.js';
import { errorFromHttpStatus, type TriageError } from './triage.js';

export interface AnthropicOptions {
  readonly apiKey: string;
  readonly baseURL?: string | undefined;
  /** Per request. A timeout is a retryable TriageError. */
  readonly timeoutMs?: number | undefined;
  /** Replaces global fetch: tests replay recorded responses through it (see ./testing). */
  readonly fetch?: typeof fetch | undefined;
}

/**
 * The Messages API as a ModelClient. The SDK's own retries are off: a failed call becomes a
 * TriageError, and the triage job's backoff retries it (full jitter, honouring Retry-After), so
 * there is one retry policy, not two stacked.
 *
 * Written for Claude Opus 5.5: thinking is always on (effort is the only control), forced tool use
 * is rejected (tool_choice is auto or none), sampling parameters are rejected, and thinking blocks
 * must come back unmodified in a tool-use loop. The final report is structured output, and tools
 * are strict, so both match their schemas as generated.
 */
export function anthropicModelClient(options: AnthropicOptions): ModelClient {
  const client = new Anthropic({
    apiKey: options.apiKey,
    baseURL: options.baseURL,
    fetch: options.fetch,
    timeout: options.timeoutMs ?? 60_000,
    maxRetries: 0,
  });
  return {
    async complete(request, { signal }) {
      const message = await attempt(
        () => client.messages.create(toParams(request), { signal }),
        toTriageError,
      );
      return message.ok ? ok(fromMessage(message.value)) : message;
    },
  };
}

const EPHEMERAL = { type: 'ephemeral' } as const;

function toParams(request: ModelRequest): Anthropic.MessageCreateParamsNonStreaming {
  const lastUser = request.messages.findLastIndex((message) => message.role === 'user');
  return {
    model: request.model,
    max_tokens: request.maxTokens,
    // Cache breakpoints: tools and system (the same every run), and the conversation so far (the
    // prefix of the next turn).
    system: [{ type: 'text', text: request.system, cache_control: EPHEMERAL }],
    tools: request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: { ...tool.inputSchema, type: 'object' },
      strict: true,
    })),
    tool_choice: { type: request.toolChoice },
    output_config: {
      effort: request.effort,
      format: { type: 'json_schema', schema: { ...request.outputSchema } },
    },
    messages: request.messages.map((message, index) => ({
      role: message.role,
      content: message.content.map((block, blockIndex) =>
        toBlockParam(block, index === lastUser && blockIndex === message.content.length - 1),
      ),
    })),
  };
}

function toBlockParam(block: ModelBlock, breakpoint: boolean): Anthropic.ContentBlockParam {
  const cache = breakpoint ? { cache_control: EPHEMERAL } : {};
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text, ...cache };
    case 'tool_use':
      return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
    case 'tool_result':
      return {
        type: 'tool_result',
        tool_use_id: block.toolUseId,
        content: block.content,
        is_error: block.isError,
        ...cache,
      };
    case 'opaque':
      // Exactly as received: the API rejects edited, reordered or dropped thinking blocks.
      return block.block as unknown as Anthropic.ContentBlockParam;
  }
}

function fromMessage(message: Anthropic.Message): ModelResponse {
  const { usage } = message;
  const cacheWriteTokens = usage.cache_creation_input_tokens ?? 0;
  const cacheReadTokens = usage.cache_read_input_tokens ?? 0;
  return {
    content: message.content.flatMap((block): ResponseBlock[] => {
      if (block.type === 'text') return [{ type: 'text', text: block.text }];
      if (block.type === 'tool_use') {
        return [{ type: 'tool_use', id: block.id, name: block.name, input: block.input }];
      }
      if (block.type === 'thinking' || block.type === 'redacted_thinking') {
        return [{ type: 'opaque', block: { ...block } }];
      }
      // Server tools and the like aren't part of the triage protocol.
      return [];
    }),
    stopReason: stopReason(message.stop_reason),
    refusal: message.stop_details?.category ?? undefined,
    usage: {
      // Cached input is still input: the budget counts all of it.
      inputTokens: usage.input_tokens + cacheWriteTokens + cacheReadTokens,
      outputTokens: usage.output_tokens,
      cacheWriteTokens,
      cacheReadTokens,
    },
  };
}

const STOP_REASONS: ReadonlySet<string> = new Set([
  'end_turn',
  'tool_use',
  'max_tokens',
  'refusal',
]);

function stopReason(reason: Anthropic.StopReason | null): ModelStopReason {
  return reason !== null && STOP_REASONS.has(reason) ? (reason as ModelStopReason) : 'other';
}

/** The I/O edge: SDK exceptions become TriageErrors. Anything else is our bug and propagates. */
function toTriageError(cause: unknown): TriageError {
  if (cause instanceof APIUserAbortError)
    return { kind: 'timeout', message: 'triage was cancelled' };
  if (cause instanceof APIConnectionTimeoutError)
    return { kind: 'timeout', message: cause.message };
  if (cause instanceof APIConnectionError) {
    const reason = cause.cause instanceof Error ? `: ${cause.cause.message}` : '';
    return { kind: 'upstream_unavailable', message: `${cause.message}${reason}` };
  }
  if (isApiError(cause)) {
    if (cause.status === undefined) return { kind: 'upstream_unavailable', message: cause.message };
    return errorFromHttpStatus(cause.status, cause.message, retryAfterMs(cause.headers));
  }
  throw cause;
}

// instanceof alone narrows to APIError<any, any, any>; this keeps the declared field types.
function isApiError(cause: unknown): cause is APIError {
  return cause instanceof APIError;
}

/** Retry-After in milliseconds: `retry-after-ms`, or `retry-after` in seconds or as an HTTP date. */
export function retryAfterMs(
  headers: Headers | undefined,
  now: number = Date.now(),
): number | undefined {
  const ms = Number(headers?.get('retry-after-ms') ?? Number.NaN);
  if (Number.isFinite(ms) && ms >= 0) return ms;
  const value = headers?.get('retry-after');
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}
