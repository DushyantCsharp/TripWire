import { describe, expect, it } from '@jest/globals';
import { anthropicModelClient, retryAfterMs } from './anthropic.js';
import type { ModelRequest } from './model.js';
import { isRetryable } from './triage.js';

const thinking = { type: 'thinking', thinking: '', signature: 'EqQBCkYIBxgCKkB…' };

const request: ModelRequest = {
  model: 'claude-opus-5-5',
  system: 'triage',
  maxTokens: 512,
  effort: 'low',
  tools: [{ name: 'query_logs', description: 'logs', inputSchema: { properties: {} } }],
  toolChoice: 'auto',
  outputSchema: { type: 'object', properties: { summary: { type: 'string' } } },
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'incident' }] },
    {
      role: 'assistant',
      content: [
        { type: 'opaque', block: thinking },
        { type: 'tool_use', id: 'toolu_1', name: 'query_logs', input: { service: 'cart' } },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', toolUseId: 'toolu_1', content: 'down', isError: true },
        { type: 'text', text: '[Tripwire] report now' },
      ],
    },
  ],
};

/** A client whose HTTP calls all get `response`; `sent` holds the request bodies. */
function clientAnswering(response: () => Response | Promise<Response>) {
  const sent: unknown[] = [];
  const client = anthropicModelClient({
    apiKey: 'test-key',
    fetch: async (input, init) => {
      sent.push(JSON.parse(await new Request(input, init).text()));
      return response();
    },
  });
  return { client, sent };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

const message = (overrides: Record<string, unknown>) => ({
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5-5',
  stop_reason: 'end_turn',
  stop_sequence: null,
  stop_details: null,
  content: [],
  usage: { input_tokens: 10, output_tokens: 5 },
  ...overrides,
});

const apiError = (type: string) => ({ type: 'error', error: { type, message: type } });

describe('anthropicModelClient', () => {
  it('sends what Opus 5.5 accepts: strict tools, auto or none, effort, a format, cache breakpoints', async () => {
    const { client, sent } = clientAnswering(() => json(200, message({})));
    await client.complete(request, {});

    expect(sent).toEqual([
      {
        model: 'claude-opus-5-5',
        max_tokens: 512,
        system: [{ type: 'text', text: 'triage', cache_control: { type: 'ephemeral' } }],
        tools: [
          {
            name: 'query_logs',
            description: 'logs',
            input_schema: { type: 'object', properties: {} },
            strict: true,
          },
        ],
        tool_choice: { type: 'auto' },
        output_config: {
          effort: 'low',
          format: {
            type: 'json_schema',
            schema: { type: 'object', properties: { summary: { type: 'string' } } },
          },
        },
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'incident' }] },
          {
            role: 'assistant',
            content: [
              // The thinking block goes back byte for byte.
              thinking,
              { type: 'tool_use', id: 'toolu_1', name: 'query_logs', input: { service: 'cart' } },
            ],
          },
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'toolu_1', content: 'down', is_error: true },
              // The conversation so far is the next turn's cached prefix.
              { type: 'text', text: '[Tripwire] report now', cache_control: { type: 'ephemeral' } },
            ],
          },
        ],
      },
    ]);
    // Never a sampling parameter: Opus 5.5 rejects them.
    expect(Object.keys(sent[0] as object)).not.toEqual(expect.arrayContaining(['temperature']));
  });

  it('sends tool_choice none when the model must answer', async () => {
    const { client, sent } = clientAnswering(() => json(200, message({})));
    await client.complete({ ...request, toolChoice: 'none' }, {});
    expect(sent[0]).toMatchObject({ tool_choice: { type: 'none' } });
  });

  it('reads back text, tool calls, thinking (opaque) and usage split by cache', async () => {
    const { client } = clientAnswering(() =>
      json(
        200,
        message({
          stop_reason: 'tool_use',
          content: [
            thinking,
            { type: 'redacted_thinking', data: 'opaque-bytes' },
            { type: 'text', text: 'Checking logs.' },
            { type: 'tool_use', id: 'toolu_2', name: 'query_logs', input: { service: 'payment' } },
          ],
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            cache_creation_input_tokens: 30,
            cache_read_input_tokens: 400,
          },
        }),
      ),
    );

    expect(await client.complete(request, {})).toEqual({
      ok: true,
      value: {
        content: [
          { type: 'opaque', block: thinking },
          { type: 'opaque', block: { type: 'redacted_thinking', data: 'opaque-bytes' } },
          { type: 'text', text: 'Checking logs.' },
          { type: 'tool_use', id: 'toolu_2', name: 'query_logs', input: { service: 'payment' } },
        ],
        stopReason: 'tool_use',
        refusal: undefined,
        // Cached input is still input: the budget counts all of it; the split prices it.
        usage: { inputTokens: 530, outputTokens: 20, cacheWriteTokens: 30, cacheReadTokens: 400 },
        // For the chat span's gen_ai.response.model and gen_ai.response.id.
        model: 'claude-opus-5-5',
        id: 'msg_1',
      },
    });
  });

  it('reads a refusal and its category', async () => {
    const { client } = clientAnswering(() =>
      json(
        200,
        message({
          stop_reason: 'refusal',
          stop_details: { type: 'refusal', category: 'cyber', explanation: null },
        }),
      ),
    );
    expect(await client.complete(request, {})).toMatchObject({
      ok: true,
      value: { stopReason: 'refusal', refusal: 'cyber' },
    });
  });

  it.each([
    ['max_tokens', 'max_tokens'],
    ['pause_turn', 'other'],
    [null, 'other'],
  ])('reads stop reason %p as %p', async (reason, expected) => {
    const { client } = clientAnswering(() => json(200, message({ stop_reason: reason })));
    expect(await client.complete(request, {})).toMatchObject({
      ok: true,
      value: { stopReason: expected },
    });
  });

  it.each([
    [
      429,
      'rate_limit_error',
      { 'retry-after': '7' },
      { kind: 'rate_limited', retryAfterMs: 7_000 },
    ],
    [529, 'overloaded_error', {}, { kind: 'upstream_unavailable', status: 529 }],
    [500, 'api_error', {}, { kind: 'upstream_unavailable', status: 500 }],
    [400, 'invalid_request_error', {}, { kind: 'request_rejected', status: 400 }],
    [401, 'authentication_error', {}, { kind: 'request_rejected', status: 401 }],
  ] as const)('maps HTTP %i (%s) to a TriageError', async (status, type, headers, expected) => {
    const { client } = clientAnswering(() => json(status, apiError(type), headers));
    expect(await client.complete(request, {})).toMatchObject({ ok: false, error: expected });
  });

  it('maps a network failure to a retryable upstream_unavailable', async () => {
    const { client } = clientAnswering(() => Promise.reject(new TypeError('fetch failed')));
    const result = await client.complete(request, {});
    expect(result).toMatchObject({
      ok: false,
      error: { kind: 'upstream_unavailable', message: expect.stringContaining('fetch failed') },
    });
    expect(!result.ok && isRetryable(result.error)).toBe(true);
  });

  it('maps cancellation to a retryable timeout', async () => {
    const controller = new AbortController();
    controller.abort();
    const { client } = clientAnswering(() => json(200, {}));
    expect(await client.complete(request, { signal: controller.signal })).toMatchObject({
      ok: false,
      error: { kind: 'timeout' },
    });
  });
});

describe('retryAfterMs', () => {
  const now = Date.parse('2026-10-01T12:00:00Z');
  it.each([
    [{ 'retry-after-ms': '1500' }, 1_500],
    [{ 'retry-after': '30' }, 30_000],
    [{ 'retry-after': 'Thu, 01 Oct 2026 12:00:10 GMT' }, 10_000],
    [{ 'retry-after': 'Thu, 01 Oct 2026 11:00:00 GMT' }, 0],
    [{ 'retry-after': 'soon' }, undefined],
    [{}, undefined],
  ])('%j → %p ms', (headers, expected) => {
    expect(retryAfterMs(new Headers(headers), now)).toBe(expected);
  });
});
