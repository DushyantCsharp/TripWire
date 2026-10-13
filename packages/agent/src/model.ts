import type { Result } from '@tripwire/result';
import type { TriageError } from './triage.js';

// The slice of a tool-use model API the triage loop speaks. Adapters (anthropic.ts) translate it to
// a provider's wire format, so the loop and its tests don't depend on one.

export interface ModelTool {
  readonly name: string;
  readonly description: string;
  /** JSON Schema for the tool's input, already reduced to what strict tool use accepts. */
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export type ModelBlock =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'tool_use';
      readonly id: string;
      readonly name: string;
      readonly input: unknown;
    }
  | {
      readonly type: 'tool_result';
      readonly toolUseId: string;
      readonly content: string;
      readonly isError: boolean;
    }
  /**
   * The model's reasoning (a thinking or redacted_thinking block) exactly as the provider returned
   * it. The loop never reads it; it goes back unmodified with the next request, which the API
   * requires in a tool-use loop.
   */
  | { readonly type: 'opaque'; readonly block: Readonly<Record<string, unknown>> };

export type ResponseBlock = Extract<ModelBlock, { type: 'text' | 'tool_use' | 'opaque' }>;

export interface ModelMessage {
  readonly role: 'user' | 'assistant';
  readonly content: readonly ModelBlock[];
}

/** How much the model reasons. Thinking is billed as output and counts against maxTokens. */
export type Effort = 'low' | 'medium' | 'high';

export interface ModelRequest {
  readonly model: string;
  readonly system: string;
  readonly maxTokens: number;
  readonly effort: Effort;
  readonly tools: readonly ModelTool[];
  /** 'auto': the model may call tools or answer. 'none': it must answer now, in outputSchema. */
  readonly toolChoice: 'auto' | 'none';
  /** JSON Schema the model's text answer must match (structured output). */
  readonly outputSchema: Readonly<Record<string, unknown>>;
  readonly messages: readonly ModelMessage[];
}

export interface ModelUsage {
  /** Every input token billed, cached or not: what the triage budget counts. */
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** The part of inputTokens written to, and read from, the prompt cache (priced differently). */
  readonly cacheWriteTokens: number;
  readonly cacheReadTokens: number;
}

export type ModelStopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'other';

export interface ModelResponse {
  readonly content: readonly ResponseBlock[];
  readonly stopReason: ModelStopReason;
  /** The category the provider gave for a refusal. */
  readonly refusal?: string | undefined;
  readonly usage: ModelUsage;
}

export interface ModelClient {
  complete(
    request: ModelRequest,
    options: { readonly signal?: AbortSignal | undefined },
  ): Promise<Result<ModelResponse, TriageError>>;
}
