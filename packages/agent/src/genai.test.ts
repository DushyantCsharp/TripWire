import { afterEach, beforeAll, describe, expect, it } from '@jest/globals';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import {
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
  TracerProvider,
} from '@opentelemetry/sdk-trace';
import { GENAI } from './genai.js';
import { claudeTriager } from './loop.js';
import { pricingFor } from './pricing.js';
import {
  answer,
  PAYMENT_INCIDENT,
  paymentTelemetry,
  SCENARIO_BUDGET,
  SCENARIO_MODEL,
  scriptedModel,
  toolUse,
  type ScriptStep,
} from './testing/index.js';

const exporter = new InMemorySpanExporter();

beforeAll(() => {
  // Once for the file: the API refuses a second global provider.
  trace.setGlobalTracerProvider(
    new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] }),
  );
});

afterEach(() => {
  exporter.reset();
});

const REPORT = {
  summary: 'payment Charge rejects tokens for gold-tier users.',
  hypotheses: [
    {
      title: 'payment Charge rejects tokens',
      explanation: 'payment logs show Charge failing with Invalid token.',
      confidence: 0.8,
      suspect: 'payment',
      faultClass: 'application_error',
      evidence: ['log:pay-7f3a'],
    },
  ],
};

const PAYMENT_LOGS = { name: 'query_logs', input: { service: 'payment', minSeverity: 'error' } };
const PAGE = {
  name: 'propose_action',
  input: {
    action: { kind: 'page', service: 'payment', urgency: 'high', message: 'Charge is failing' },
    rationale: 'payment Charge fails for gold-tier users.',
    evidence: ['log:pay-7f3a'],
  },
};

const CONTENT = [
  GENAI.systemInstructions,
  GENAI.inputMessages,
  GENAI.outputMessages,
  GENAI.toolArguments,
  GENAI.toolResult,
];

async function triage(
  steps: readonly ScriptStep[],
  {
    captureContent,
    maxToolCalls = 2,
    tracesDown = false,
  }: { captureContent?: boolean; maxToolCalls?: number; tracesDown?: boolean } = {},
) {
  const telemetry = paymentTelemetry({ tracesDown });
  const result = await claudeTriager({
    model: SCENARIO_MODEL,
    client: scriptedModel(steps),
    tools: telemetry.handlers,
    pricing: pricingFor(SCENARIO_MODEL),
    captureContent,
  }).triage(PAYMENT_INCIDENT, {
    budget: { ...SCENARIO_BUDGET, maxToolCalls },
    runKey: 'triage-run-1',
  });
  return { result, spans: exporter.getFinishedSpans() };
}

const only = (spans: readonly ReadableSpan[], name: string) => {
  const found = spans.filter((s) => s.name === name);
  if (found.length !== 1) throw new Error(`${String(found.length)} spans named ${name}`);
  return found[0] as ReadableSpan;
};

describe('GenAI spans', () => {
  // Logs, then a page plus a call past the limit, then the report.
  const steps = [toolUse([PAYMENT_LOGS]), toolUse([PAGE, PAYMENT_LOGS]), answer(REPORT)];

  it('traces the run, each model call and each tool call, under one invoke_agent span', async () => {
    const { result, spans } = await triage(steps);
    expect(result.ok).toBe(true);

    const run = only(spans, 'invoke_agent tripwire-triage');
    expect(run.attributes).toMatchObject({
      [GENAI.operation]: 'invoke_agent',
      [GENAI.agentName]: 'tripwire-triage',
      [GENAI.provider]: 'anthropic',
      [GENAI.requestModel]: SCENARIO_MODEL,
      [GENAI.conversation]: 'triage-run-1',
      'tripwire.incident.id': PAYMENT_INCIDENT.incidentId,
      'tripwire.stop_reason': 'report_submitted',
      'tripwire.tool_calls': 2,
      'tripwire.model_calls': 3,
    });
    expect(run.attributes['tripwire.cost_usd']).toBeGreaterThan(0);

    const chats = spans.filter((s) => s.name === `chat ${SCENARIO_MODEL}`);
    expect(chats.map((s) => s.attributes[GENAI.finishReasons])).toEqual([
      ['tool_use'],
      ['tool_use'],
      ['end_turn'],
    ]);
    expect(chats[0]?.attributes).toMatchObject({
      [GENAI.operation]: 'chat',
      [GENAI.provider]: 'anthropic',
      [GENAI.requestModel]: SCENARIO_MODEL,
      [GENAI.inputTokens]: expect.any(Number),
      [GENAI.outputTokens]: expect.any(Number),
      [GENAI.cacheReadTokens]: expect.any(Number),
    });
    expect(typeof chats[0]?.attributes[GENAI.maxTokens]).toBe('number');

    const tools = spans.filter((s) => s.name.startsWith('execute_tool '));
    expect(
      tools.map((s) => [
        s.name,
        s.attributes[GENAI.toolCallId],
        s.attributes['tripwire.tool.outcome'],
      ]),
    ).toEqual(
      expect.arrayContaining([
        ['execute_tool query_logs', 'toolu_query_logs_0', 'ok'],
        ['execute_tool propose_action', 'toolu_propose_action_0', 'proposal_accepted'],
        ['execute_tool query_logs', 'toolu_query_logs_1', 'refused'],
      ]),
    );
    expect(tools).toHaveLength(3);
    for (const span of [...chats, ...tools]) {
      expect(span.parentSpanContext?.spanId).toBe(run.spanContext().spanId);
      expect(span.spanContext().traceId).toBe(run.spanContext().traceId);
    }
    // A refusal or an accepted proposal is not an error.
    for (const span of tools) expect(span.status.code).toBe(SpanStatusCode.UNSET);
  });

  it('records no prompts, completions, tool arguments or results by default', async () => {
    const { spans } = await triage(steps);
    for (const span of spans) {
      for (const key of CONTENT)
        expect([span.name, key, span.attributes[key]]).toEqual([span.name, key, undefined]);
    }
  });

  it('records them when asked to', async () => {
    const { spans } = await triage(steps, { captureContent: true });
    const [first] = spans.filter((s) => s.name === `chat ${SCENARIO_MODEL}`);
    expect(String(first?.attributes[GENAI.inputMessages])).toContain('<incident>');
    expect(String(first?.attributes[GENAI.outputMessages])).toContain('tool_call');
    const logs = spans.find(
      (s) => s.name === 'execute_tool query_logs' && s.attributes['tripwire.tool.outcome'] === 'ok',
    );
    expect(String(logs?.attributes[GENAI.toolArguments])).toContain('payment');
    expect(String(logs?.attributes[GENAI.toolResult])).toContain('<tool_output tool="query_logs">');
  });

  it('marks a failed model call, and the run, with the error', async () => {
    const { result, spans } = await triage([
      { kind: 'upstream_unavailable', message: 'the API answered 529' },
    ]);
    expect(result.ok).toBe(false);
    for (const name of [`chat ${SCENARIO_MODEL}`, 'invoke_agent tripwire-triage']) {
      const span = only(spans, name);
      expect(span.status).toEqual({ code: SpanStatusCode.ERROR, message: 'the API answered 529' });
      expect(span.attributes[GENAI.errorType]).toBe('upstream_unavailable');
    }
  });

  it('marks a tool whose backend is down as failed', async () => {
    const { spans } = await triage(
      [toolUse([{ name: 'query_traces', input: { service: 'payment' } }]), answer(REPORT)],
      { tracesDown: true },
    );
    const traces = only(spans, 'execute_tool query_traces');
    expect(traces.status.code).toBe(SpanStatusCode.ERROR);
    expect(traces.attributes).toMatchObject({
      'tripwire.tool.outcome': 'unavailable',
      [GENAI.errorType]: 'unavailable',
    });
  });
});
