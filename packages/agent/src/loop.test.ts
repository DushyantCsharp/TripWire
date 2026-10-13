import { describe, expect, it } from '@jest/globals';
import { err, ok, type Result } from '@tripwire/result';
import { payloadHash } from './approval.js';
import {
  claudeTriager,
  type ClaudeTriagerOptions,
  type TriageEvent,
  UNAVAILABLE_EVIDENCE_PENALTY,
} from './loop.js';
import { memoryLogStore } from './memory.js';
import type { ModelRequest } from './model.js';
import { proposalId } from './policy.js';
import { pricingFor } from './pricing.js';
import { REPORT_OUTPUT_SCHEMA } from './report.js';
import {
  answer,
  manualClock,
  PAYMENT_INCIDENT,
  paymentTelemetry,
  SCENARIO_BUDGET,
  SCENARIO_MODEL,
  SCENARIO_NOW,
  scriptedModel,
  toolUse,
  usage,
  type ScriptStep,
} from './testing/index.js';
import { telemetryTools } from './tools/telemetry.js';
import type { TriageBudget, TriageError, TriageReport } from './triage.js';

const REPORT = {
  summary: 'payment Charge rejects tokens for gold-tier users; checkout fails with it.',
  hypotheses: [
    {
      title: 'checkout regression',
      explanation: 'checkout surfaces the errors but only relays them.',
      confidence: 0.1,
      suspect: 'checkout',
      faultClass: 'application_error',
      evidence: ['log:chk-21c0'],
    },
    {
      title: 'payment Charge rejects tokens',
      explanation: 'payment logs show Charge failing with Invalid token since 12:04.',
      confidence: 0.8,
      suspect: 'payment',
      faultClass: 'application_error',
      evidence: ['log:pay-7f3a', 'log:pay-7f3a', 'log:never-returned'],
    },
  ],
};

const PAYMENT_LOGS = { name: 'query_logs', input: { service: 'payment', minSeverity: 'error' } };
const CHECKOUT_LOGS = { name: 'query_logs', input: { service: 'checkout' } };

interface Run {
  readonly steps: readonly ScriptStep[];
  readonly budget?: Partial<TriageBudget>;
  readonly options?: Partial<ClaudeTriagerOptions>;
  readonly telemetry?: ReturnType<typeof paymentTelemetry>;
  readonly signal?: AbortSignal;
}

async function run({ steps, budget, options, telemetry = paymentTelemetry(), signal }: Run) {
  const model = scriptedModel(steps);
  const events: TriageEvent[] = [];
  const triager = claudeTriager({
    model: SCENARIO_MODEL,
    client: model,
    tools: telemetry.handlers,
    pricing: pricingFor(SCENARIO_MODEL),
    onEvent: (event) => events.push(event),
    ...options,
  });
  const result = await triager.triage(PAYMENT_INCIDENT, {
    budget: { ...SCENARIO_BUDGET, ...budget },
    runKey: 'triage-run-1',
    signal,
  });
  return { result, requests: model.requests, telemetry, events };
}

function report(result: Result<TriageReport, TriageError>): TriageReport {
  if (!result.ok) throw new Error(`triage failed: ${result.error.kind}: ${result.error.message}`);
  return result.value;
}

/** The text blocks of the last user message in a request: notes the loop appended. */
function notes(request: ModelRequest | undefined): string[] {
  const last = request?.messages.at(-1);
  return (last?.content ?? []).flatMap((block) => (block.type === 'text' ? [block.text] : []));
}

function toolResults(request: ModelRequest | undefined) {
  return (request?.messages.at(-1)?.content ?? []).flatMap((block) =>
    block.type === 'tool_result' ? [block] : [],
  );
}

describe('triage loop', () => {
  it('calls tools, then reports: cited evidence, ranked by confidence, with usage and cost', async () => {
    const { result, telemetry } = await run({
      steps: [
        toolUse([PAYMENT_LOGS, CHECKOUT_LOGS], usage(3_000, 200)),
        answer(REPORT, usage(4_000, 300)),
      ],
    });
    const triage = report(result);

    expect(telemetry.calls).toEqual(['query_logs', 'query_logs']);
    expect(triage).toMatchObject({
      model: SCENARIO_MODEL,
      basis: 'model',
      stopReason: 'report_submitted',
      windDown: null,
      summary: REPORT.summary,
      confidence: 0.8,
      usage: { inputTokens: 7_000, outputTokens: 500, toolCalls: 2, modelCalls: 2 },
    });
    // $4/MTok in, $20/MTok out: 7,000 × 4 + 500 × 20 micro-dollars.
    expect(triage.usage.costUsdMicros).toBe(38_000);
    // The model's order is ignored: hypotheses are ranked by confidence.
    expect(triage.hypotheses.map((h) => [h.rank, h.suspect, h.faultClass])).toEqual([
      [1, 'payment', 'application_error'],
      [2, 'checkout', 'application_error'],
    ]);
    // Each id once, and only ids a tool returned.
    expect(triage.hypotheses[0]?.evidence.map((e) => e.sourceId)).toEqual(['log:pay-7f3a']);
    expect(triage.hypotheses[0]?.evidence[0]).toMatchObject({
      kind: 'log',
      available: true,
      excerpt: expect.stringContaining('Invalid token') as unknown,
    });
    expect(triage.rejectedCitations).toEqual(['log:never-returned']);
  });

  it('speaks the protocol Opus 5.5 accepts: auto tool choice, low effort, structured report', async () => {
    const { requests } = await run({ steps: [toolUse([PAYMENT_LOGS]), answer(REPORT)] });
    const [first, second] = requests;

    expect(first).toMatchObject({
      model: SCENARIO_MODEL,
      toolChoice: 'auto',
      effort: 'low',
      maxTokens: 1_200,
      outputSchema: REPORT_OUTPUT_SCHEMA,
    });
    expect(first?.tools.map((tool) => tool.name)).toEqual([
      'query_logs',
      'query_traces',
      'query_metrics',
      'list_deploys',
      'get_runbook',
      'propose_action',
    ]);
    // The assistant turn goes back exactly as it came, thinking block and all.
    expect(second?.messages[1]).toEqual({
      role: 'assistant',
      content: toolUse([PAYMENT_LOGS]).content,
    });
    const [result] = toolResults(second);
    expect(result?.content.startsWith('<tool_output tool="query_logs">\n')).toBe(true);
    expect(result?.content.endsWith('\n</tool_output>')).toBe(true);
  });

  it('lowers confidence once per kind of evidence it could not gather, and carries on', async () => {
    const telemetry = paymentTelemetry({ tracesDown: true });
    const { result, requests } = await run({
      telemetry,
      steps: [
        toolUse([PAYMENT_LOGS, { name: 'query_traces', input: { service: 'payment' } }]),
        answer(REPORT),
      ],
    });
    const triage = report(result);

    expect(triage.unavailableEvidence).toEqual([
      {
        kind: 'trace',
        sourceId: 'query_traces {"errorsOnly":true,"limit":5,"minutes":30,"service":"payment"}',
        excerpt: null,
        available: false,
        unavailableReason: 'Jaeger timed out after 10s',
        url: null,
      },
    ]);
    expect(triage.hypotheses[0]?.confidence).toBeCloseTo(0.8 * UNAVAILABLE_EVIDENCE_PENALTY, 3);
    expect(UNAVAILABLE_EVIDENCE_PENALTY).toBeLessThan(1);
    expect(triage.stopReason).toBe('report_submitted');
    // The model was told, inside the delimiter.
    const failed = toolResults(requests[1]).find((block) => block.isError);
    expect(failed?.content).toContain('<tool_output tool="query_traces" error="true">');
    expect(failed?.content).toContain('Jaeger timed out after 10s');
  });

  it("doesn't count a rejected query as missing evidence", async () => {
    const telemetry = paymentTelemetry();
    const { result } = await run({
      telemetry,
      steps: [
        toolUse([PAYMENT_LOGS, { name: 'query_logs', input: { cursor: 'bm90LWEtY3Vyc29y' } }]),
        answer(REPORT),
      ],
    });
    expect(report(result).unavailableEvidence).toEqual([]);
    expect(report(result).confidence).toBe(0.8);
  });

  it('returns errors for unknown tools and bad input, and counts them as calls', async () => {
    const { result, requests, telemetry } = await run({
      steps: [
        toolUse([
          { name: 'delete_database', input: {} },
          { name: 'query_logs', input: { limit: 500 } },
        ]),
        answer({ ...REPORT, hypotheses: REPORT.hypotheses.map((h) => ({ ...h, evidence: [] })) }),
      ],
    });
    expect(telemetry.calls).toEqual([]);
    expect(report(result).usage.toolCalls).toBe(2);
    const [unknown, invalid] = toolResults(requests[1]);
    expect(unknown).toMatchObject({
      isError: true,
      content: expect.stringContaining('unknown_tool') as unknown,
    });
    expect(invalid).toMatchObject({
      isError: true,
      content: expect.stringContaining('invalid_input') as unknown,
    });
  });

  it("passes on the model provider's errors, for the job to retry", async () => {
    const rateLimited: TriageError = { kind: 'rate_limited', message: '429', retryAfterMs: 7_000 };
    const { result } = await run({ steps: [rateLimited] });
    expect(result).toEqual(err(rateLimited));
  });

  it('cuts a large tool result to its size budget, and cites only what the model saw', async () => {
    const lines = Array.from({ length: 50 }, (_, i) => ({
      id: `big-${String(i).padStart(2, '0')}`,
      at: new Date(SCENARIO_NOW.getTime() - (i + 1) * 1_000),
      service: 'payment',
      severityNumber: 17,
      body: `Charge failed for order ${String(i)}: ${'x'.repeat(150)}`,
    }));
    const handlers = telemetryTools(
      {
        ...portsWithout(),
        logs: memoryLogStore(lines),
      },
      { now: () => SCENARIO_NOW },
    );
    const { result, requests } = await run({
      telemetry: { handlers, calls: [], returned: new Map() },
      steps: [
        toolUse([{ name: 'query_logs', input: { service: 'payment', limit: 50 } }]),
        answer({
          ...REPORT,
          hypotheses: [{ ...REPORT.hypotheses[1], evidence: ['log:big-00', 'log:big-49'] }],
        }),
      ],
    });
    const [logs] = toolResults(requests[1]);
    expect(logs?.content.length).toBeLessThanOrEqual(4_000 + 60);
    expect(logs?.content).toContain('"truncated":true');
    expect(report(result).hypotheses[0]?.evidence.map((e) => e.sourceId)).toEqual(['log:big-00']);
    expect(report(result).rejectedCitations).toEqual(['log:big-49']);
  });

  it('reports what it did as it goes', async () => {
    const { events } = await run({ steps: [toolUse([PAYMENT_LOGS]), answer(REPORT)] });
    expect(events.map((event) => event.type)).toEqual([
      'model_call',
      'tool_call',
      'model_call',
      'stop',
    ]);
    expect(events[1]).toMatchObject({ type: 'tool_call', name: 'query_logs', outcome: 'ok' });
  });

  it("doesn't offer a tool without a backend", async () => {
    const { list_deploys: _none, ...handlers } = paymentTelemetry().handlers;
    const { requests, result } = await run({
      telemetry: { handlers, calls: [], returned: new Map() },
      steps: [toolUse([{ name: 'list_deploys', input: {} }]), answer(REPORT)],
    });
    expect(requests[0]?.tools.map((tool) => tool.name)).not.toContain('list_deploys');
    expect(toolResults(requests[1])[0]?.content).toContain('unknown_tool');
    expect(report(result).stopReason).toBe('report_submitted');
  });
});

describe('triage loop limits', () => {
  it('asks for the report once the tool calls are used, refusing calls beyond them', async () => {
    const nine = Array.from({ length: 9 }, () => PAYMENT_LOGS);
    const { result, requests, telemetry } = await run({ steps: [toolUse(nine), answer(REPORT)] });
    const triage = report(result);

    expect(telemetry.calls).toHaveLength(8);
    expect(triage).toMatchObject({ stopReason: 'report_submitted', windDown: 'tool_call_limit' });
    expect(triage.usage.toolCalls).toBe(8);
    const results = toolResults(requests[1]);
    expect(results).toHaveLength(9);
    expect(results[8]).toMatchObject({
      isError: true,
      content: expect.stringContaining('not_run') as unknown,
    });
    // The report turn: no tools, and told why.
    expect(requests[1]?.toolChoice).toBe('none');
    expect(notes(requests[1])).toEqual([
      expect.stringMatching(/^\[Tripwire\] You have used all 8 tool calls/),
    ]);
    expect(requests[1]?.maxTokens).toBe(4_000 - 100);
  });

  it('asks for the report while the input budget still has room for it and a repair', async () => {
    const { result, requests } = await run({
      budget: { maxInputTokens: 10_000 },
      steps: [toolUse([PAYMENT_LOGS], usage(3_500, 100)), answer(REPORT, usage(4_000, 300))],
    });
    expect(report(result)).toMatchObject({
      stopReason: 'report_submitted',
      windDown: 'input_token_budget',
    });
    expect(requests[1]?.toolChoice).toBe('none');
    expect(report(result).usage.inputTokens).toBe(7_500);
  });

  it('stops without asking when not even the report would fit the input budget', async () => {
    const { result, requests } = await run({ budget: { maxInputTokens: 500 }, steps: [] });
    const triage = report(result);
    expect(requests).toHaveLength(0);
    expect(triage).toMatchObject({ stopReason: 'input_token_budget', basis: 'alert_labels' });
    // The fallback ranks every alert of the incident, not just the recent ones.
    expect(triage.hypotheses.map((h) => [h.suspect, h.faultClass, h.evidence])).toEqual([
      ['checkout', null, []],
      ['payment', null, []],
      ['frontend', null, []],
    ]);
    expect(triage.summary).toContain('input token budget spent');
  });

  it('ends with a partial report when a tool turn goes over the input budget', async () => {
    const { result, telemetry } = await run({
      steps: [toolUse([PAYMENT_LOGS], usage(41_000, 100))],
    });
    expect(telemetry.calls).toEqual(['query_logs']);
    expect(report(result)).toMatchObject({
      stopReason: 'input_token_budget',
      basis: 'alert_labels',
    });
  });

  it("keeps a valid report that arrives over budget, but doesn't call it complete", async () => {
    const { result } = await run({ steps: [answer(REPORT, usage(41_000, 300))] });
    expect(report(result)).toMatchObject({ stopReason: 'input_token_budget', basis: 'model' });
  });

  it('keeps output for the report: turns that may call tools get what is left above it', async () => {
    const { result, requests } = await run({
      budget: { maxOutputTokens: 2_000 },
      steps: [toolUse([PAYMENT_LOGS], usage(1_000, 400)), answer(REPORT, usage(2_000, 900))],
    });
    expect(requests[0]?.maxTokens).toBe(500);
    expect(requests[1]).toMatchObject({ toolChoice: 'none', maxTokens: 1_600 });
    expect(report(result)).toMatchObject({
      stopReason: 'report_submitted',
      windDown: 'output_token_budget',
    });
  });

  it('asks for the report as the wall-clock limit nears', async () => {
    const clock = manualClock();
    const { result, requests } = await run({
      options: { clock },
      steps: [
        () => {
          clock.advance(45_000);
          return Promise.resolve(ok(toolUse([PAYMENT_LOGS])));
        },
        answer(REPORT),
      ],
    });
    expect(requests[1]?.toolChoice).toBe('none');
    expect(notes(requests[1])).toEqual([expect.stringMatching(/Time is nearly up/)]);
    expect(report(result)).toMatchObject({
      stopReason: 'report_submitted',
      windDown: 'wall_clock',
    });
  });

  it('ends with a partial report when the wall-clock limit passes during a model call', async () => {
    const clock = manualClock();
    const { result } = await run({
      options: { clock },
      steps: [
        (_request, signal) => {
          const answered = new Promise<Result<never, TriageError>>((resolve) => {
            signal?.addEventListener('abort', () => {
              resolve(err({ kind: 'timeout', message: 'triage was cancelled' }));
            });
          });
          clock.advance(60_000);
          return answered;
        },
      ],
    });
    expect(report(result)).toMatchObject({ stopReason: 'wall_clock', basis: 'alert_labels' });
  });

  it('ends with a partial report when the wall-clock limit passes during a tool call', async () => {
    const clock = manualClock();
    const telemetry = paymentTelemetry();
    const handlers = {
      ...telemetry.handlers,
      query_traces: (_input: unknown, { signal }: { signal?: AbortSignal | undefined }) => {
        const timedOut = new Promise<Result<never, { kind: 'unavailable'; message: string }>>(
          (resolve) => {
            signal?.addEventListener('abort', () => {
              resolve(err({ kind: 'unavailable', message: 'Jaeger timed out' }));
            });
          },
        );
        clock.advance(60_000);
        return timedOut;
      },
    };
    const { result } = await run({
      options: { clock },
      telemetry: { ...telemetry, handlers },
      steps: [toolUse([{ name: 'query_traces', input: { service: 'payment' } }])],
    });
    const triage = report(result);
    expect(triage.stopReason).toBe('wall_clock');
    expect(triage.unavailableEvidence).toEqual([expect.objectContaining({ kind: 'trace' })]);
  });

  it('gives each tool call its own timeout, so one slow backend is only missing evidence', async () => {
    const clock = manualClock();
    const telemetry = paymentTelemetry();
    const handlers = {
      ...telemetry.handlers,
      query_metrics: (_input: unknown, { signal }: { signal?: AbortSignal | undefined }) => {
        const timedOut = new Promise<Result<never, { kind: 'unavailable'; message: string }>>(
          (resolve) => {
            signal?.addEventListener('abort', () => {
              resolve(err({ kind: 'unavailable', message: 'Prometheus timed out' }));
            });
          },
        );
        clock.advance(10_000);
        return timedOut;
      },
    };
    const { result } = await run({
      options: { clock },
      telemetry: { ...telemetry, handlers },
      steps: [
        toolUse([{ name: 'query_metrics', input: { promql: 'up' } }, PAYMENT_LOGS]),
        answer(REPORT),
      ],
    });
    const triage = report(result);
    expect(triage.stopReason).toBe('report_submitted');
    expect(triage.unavailableEvidence).toEqual([
      expect.objectContaining({ kind: 'metric', unavailableReason: 'Prometheus timed out' }),
    ]);
  });

  it("is cancelled, not cut short, when the job is: that's an error the job retries", async () => {
    const job = new AbortController();
    const { result } = await run({
      signal: job.signal,
      steps: [
        (_request, signal) => {
          const answered = new Promise<Result<never, TriageError>>((resolve) => {
            signal?.addEventListener('abort', () => {
              resolve(err({ kind: 'timeout', message: 'triage was cancelled' }));
            });
          });
          job.abort();
          return answered;
        },
      ],
    });
    expect(result).toEqual(err({ kind: 'timeout', message: 'triage was cancelled' }));
  });
});

describe('triage report validation', () => {
  it('repairs an invalid report once', async () => {
    const { result, requests, events } = await run({
      steps: [answer('{"summary": "payment'), answer(REPORT)],
    });
    expect(requests[1]?.toolChoice).toBe('none');
    expect(notes(requests[1])).toEqual([
      expect.stringMatching(/^\[Tripwire\] Your report was not accepted: not valid JSON/),
    ]);
    expect(report(result)).toMatchObject({ stopReason: 'report_submitted', basis: 'model' });
    expect(events.filter((event) => event.type === 'repair')).toHaveLength(1);
  });

  it('names what failed validation, by path', async () => {
    const { requests } = await run({
      steps: [answer({ summary: 'x', hypotheses: [] }), answer(REPORT)],
    });
    expect(notes(requests[1])[0]).toContain('hypotheses');
  });

  it('ends with a partial report when the repair is invalid too', async () => {
    const { result, requests } = await run({ steps: [answer('{}'), answer({ summary: 1 })] });
    expect(requests).toHaveLength(2);
    expect(report(result)).toMatchObject({ stopReason: 'invalid_output', basis: 'alert_labels' });
  });

  it('repairs a report whose hypotheses cite nothing the tools returned', async () => {
    const uncited = {
      ...REPORT,
      hypotheses: [{ ...REPORT.hypotheses[1], evidence: ['log:made-up'] }],
    };
    const { result, requests } = await run({
      steps: [toolUse([PAYMENT_LOGS]), answer(uncited), answer(REPORT)],
    });
    expect(notes(requests[2])[0]).toContain('cites no id that a tool returned');
    expect(report(result).stopReason).toBe('report_submitted');
  });

  it('runs out of output when a truncated report is truncated again', async () => {
    const truncated = { ...answer('{"summary": "pay'), stopReason: 'max_tokens' as const };
    const { result } = await run({ steps: [truncated, truncated] });
    expect(report(result).stopReason).toBe('output_token_budget');
  });

  it('ends with a partial report when the model declines', async () => {
    const refusal = { ...answer(''), stopReason: 'refusal' as const, refusal: 'cyber' };
    const { result } = await run({ steps: [refusal] });
    expect(report(result)).toMatchObject({ stopReason: 'refusal', basis: 'alert_labels' });
  });

  it('runs no tools once the report is asked for, and counts calling them as its repair', async () => {
    const nine = Array.from({ length: 8 }, () => PAYMENT_LOGS);
    const { result, requests, telemetry } = await run({
      steps: [toolUse(nine), toolUse([CHECKOUT_LOGS]), answer(REPORT)],
    });
    expect(telemetry.calls).toHaveLength(8);
    expect(toolResults(requests[2])[0]).toMatchObject({
      isError: true,
      content: expect.stringContaining('tools are no longer available') as unknown,
    });
    expect(notes(requests[2])[0]).toContain('you called tools after being asked for the report');
    expect(report(result).stopReason).toBe('report_submitted');
  });
});

describe('propose_action', () => {
  it('records proposals that pass policy, and refuses the rest, executing nothing', async () => {
    const rollback = {
      action: {
        kind: 'rollback',
        service: 'payment',
        changeId: 'change:config-payment-2026-10-01T11:59:30Z',
      },
      rationale: 'Charge started failing right after this config change.',
      evidence: ['log:pay-7f3a', 'change:config-payment-2026-10-01T11:59:30Z'],
    };
    const prod = {
      action: {
        kind: 'rollback',
        service: 'prod',
        changeId: 'change:config-payment-2026-10-01T11:59:30Z',
      },
      rationale: 'roll back prod',
      evidence: ['log:pay-7f3a'],
    };
    const { result, requests } = await run({
      steps: [
        toolUse([PAYMENT_LOGS, { name: 'list_deploys', input: {} }]),
        toolUse([
          { name: 'propose_action', input: rollback },
          { name: 'propose_action', input: prod },
        ]),
        answer(REPORT),
      ],
    });
    const triage = report(result);
    const payload = {
      kind: 'rollback',
      service: 'payment',
      changeId: 'change:config-payment-2026-10-01T11:59:30Z',
    };

    expect(triage.proposedActions).toEqual([
      {
        id: proposalId('triage-run-1', payloadHash(payload)),
        kind: 'rollback',
        summary: 'Roll back payment change change:config-payment-2026-10-01T11:59:30Z',
        rationale: rollback.rationale,
        payload,
        payloadHash: payloadHash(payload),
        evidence: rollback.evidence,
      },
    ]);
    expect(triage.rejectedProposals).toEqual([
      expect.objectContaining({ reason: 'unknown_service', input: prod }),
    ]);
    expect(triage.usage.toolCalls).toBe(4);
    const [accepted, rejected] = toolResults(requests[2]);
    expect(accepted?.content).toContain('"status":"pending_approval"');
    expect(accepted?.content).toContain('Nothing was executed');
    expect(rejected).toMatchObject({
      isError: true,
      content: expect.stringContaining('unknown_service') as unknown,
    });
  });
});

/** Ports whose every backend is unused: tests replace the one they need. */
function portsWithout() {
  const unused = () => Promise.resolve(err({ kind: 'unavailable' as const, message: 'unused' }));
  return {
    logs: { search: unused },
    traces: { search: unused },
    metrics: { queryRange: unused },
    runbooks: { search: unused },
  };
}
