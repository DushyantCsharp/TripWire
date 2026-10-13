import {
  type Attributes,
  type Context,
  type Span,
  SpanKind,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api';
import type { Result } from '@tripwire/result';
import type { ToolOutcome } from './loop.js';
import type { ModelBlock, ModelMessage, ModelRequest, ModelResponse } from './model.js';
import type { TriageError, TriageReport } from './triage.js';

// OpenTelemetry spans for the triage loop, following the GenAI semantic conventions (gen_ai.*,
// semconv 1.37 and later): `invoke_agent` for a run, `chat <model>` for each model call and
// `execute_tool <name>` for each tool call. The attribute names are written out here rather than
// imported from semconv's incubating entry point. Prompts, completions, tool arguments and results
// are recorded only with captureContent: they hold the incident and whatever the logs said.

export const GENAI = {
  operation: 'gen_ai.operation.name',
  provider: 'gen_ai.provider.name',
  agentName: 'gen_ai.agent.name',
  conversation: 'gen_ai.conversation.id',
  requestModel: 'gen_ai.request.model',
  maxTokens: 'gen_ai.request.max_tokens',
  responseModel: 'gen_ai.response.model',
  responseId: 'gen_ai.response.id',
  finishReasons: 'gen_ai.response.finish_reasons',
  inputTokens: 'gen_ai.usage.input_tokens',
  outputTokens: 'gen_ai.usage.output_tokens',
  cacheReadTokens: 'gen_ai.usage.cache_read.input_tokens',
  cacheWriteTokens: 'gen_ai.usage.cache_creation.input_tokens',
  toolName: 'gen_ai.tool.name',
  toolCallId: 'gen_ai.tool.call.id',
  toolType: 'gen_ai.tool.type',
  systemInstructions: 'gen_ai.system_instructions',
  inputMessages: 'gen_ai.input.messages',
  outputMessages: 'gen_ai.output.messages',
  toolArguments: 'gen_ai.tool.call.arguments',
  toolResult: 'gen_ai.tool.call.result',
  errorType: 'error.type',
} as const;

export const AGENT_NAME = 'tripwire-triage';
const PROVIDER = 'anthropic';

const tracer = () => trace.getTracer('@tripwire/agent');

type Part = Readonly<Record<string, unknown>>;

/** A message's parts as the conventions write them; reasoning blocks are left out. */
function parts(blocks: readonly ModelBlock[]): Part[] {
  return blocks.flatMap((block): Part[] => {
    if (block.type === 'text') return [{ type: 'text', content: block.text }];
    if (block.type === 'tool_use') {
      return [{ type: 'tool_call', id: block.id, name: block.name, arguments: block.input }];
    }
    if (block.type === 'tool_result') {
      return [{ type: 'tool_call_response', id: block.toolUseId, response: block.content }];
    }
    return [];
  });
}

const messages = (list: readonly ModelMessage[]) =>
  JSON.stringify(list.map((message) => ({ role: message.role, parts: parts(message.content) })));

export function startRunSpan(
  parent: Context,
  { model, runKey, incidentId }: { model: string; runKey: string; incidentId: string },
): Span {
  return tracer().startSpan(
    `invoke_agent ${AGENT_NAME}`,
    {
      kind: SpanKind.INTERNAL,
      attributes: {
        [GENAI.operation]: 'invoke_agent',
        [GENAI.provider]: PROVIDER,
        [GENAI.agentName]: AGENT_NAME,
        [GENAI.requestModel]: model,
        [GENAI.conversation]: runKey,
        'tripwire.incident.id': incidentId,
      },
    },
    parent,
  );
}

export function endRunSpan(span: Span, result: Result<TriageReport, TriageError>): void {
  if (result.ok) {
    const { usage, stopReason } = result.value;
    span.setAttributes({
      'tripwire.stop_reason': stopReason,
      'tripwire.tool_calls': usage.toolCalls,
      'tripwire.model_calls': usage.modelCalls,
      'tripwire.cost_usd': usage.costUsdMicros / 1_000_000,
      [GENAI.inputTokens]: usage.inputTokens,
      [GENAI.outputTokens]: usage.outputTokens,
    });
  } else {
    span.setAttribute(GENAI.errorType, result.error.kind);
    span.setStatus({ code: SpanStatusCode.ERROR, message: result.error.message });
  }
  span.end();
}

export function startChatSpan(parent: Context, request: ModelRequest, captureContent: boolean) {
  const attributes: Attributes = {
    [GENAI.operation]: 'chat',
    [GENAI.provider]: PROVIDER,
    [GENAI.requestModel]: request.model,
    [GENAI.maxTokens]: request.maxTokens,
    'tripwire.tool_choice': request.toolChoice,
  };
  if (captureContent) {
    attributes[GENAI.systemInstructions] = JSON.stringify([
      { type: 'text', content: request.system },
    ]);
    attributes[GENAI.inputMessages] = messages(request.messages);
  }
  return tracer().startSpan(`chat ${request.model}`, { kind: SpanKind.CLIENT, attributes }, parent);
}

export function endChatSpan(
  span: Span,
  response: Result<ModelResponse, TriageError>,
  captureContent: boolean,
): void {
  if (response.ok) {
    const { usage, stopReason, model, id, content } = response.value;
    span.setAttributes({
      [GENAI.finishReasons]: [stopReason],
      [GENAI.inputTokens]: usage.inputTokens,
      [GENAI.outputTokens]: usage.outputTokens,
      [GENAI.cacheReadTokens]: usage.cacheReadTokens,
      [GENAI.cacheWriteTokens]: usage.cacheWriteTokens,
      ...(model === undefined ? {} : { [GENAI.responseModel]: model }),
      ...(id === undefined ? {} : { [GENAI.responseId]: id }),
    });
    if (captureContent) {
      span.setAttribute(GENAI.outputMessages, messages([{ role: 'assistant', content }]));
    }
  } else {
    span.setAttribute(GENAI.errorType, response.error.kind);
    span.setStatus({ code: SpanStatusCode.ERROR, message: response.error.message });
  }
  span.end();
}

export function startToolSpan(
  parent: Context,
  call: { readonly id: string; readonly name: string; readonly input: unknown },
  captureContent: boolean,
): Span {
  return tracer().startSpan(
    `execute_tool ${call.name}`,
    {
      kind: SpanKind.INTERNAL,
      attributes: {
        [GENAI.operation]: 'execute_tool',
        [GENAI.toolName]: call.name,
        [GENAI.toolCallId]: call.id,
        [GENAI.toolType]: 'function',
        ...(captureContent ? { [GENAI.toolArguments]: JSON.stringify(call.input) } : {}),
      },
    },
    parent,
  );
}

/** Outcomes where the tool itself failed; a refusal or a rejected proposal is policy, not error. */
const FAILED: ReadonlySet<ToolOutcome> = new Set([
  'unavailable',
  'invalid_query',
  'invalid_input',
  'unknown_tool',
]);

export function endToolSpan(
  span: Span,
  outcome: ToolOutcome,
  block: ModelBlock,
  captureContent: boolean,
): void {
  span.setAttribute('tripwire.tool.outcome', outcome);
  if (captureContent && block.type === 'tool_result') {
    span.setAttribute(GENAI.toolResult, block.content);
  }
  if (FAILED.has(outcome)) {
    span.setAttribute(GENAI.errorType, outcome);
    span.setStatus({ code: SpanStatusCode.ERROR });
  }
  span.end();
}
