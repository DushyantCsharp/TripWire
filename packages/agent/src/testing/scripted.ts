// A scripted model and a manual clock, for testing the loop's protocol: limits, repairs, refusals,
// cancellation. Each step answers one request; tests read back what the loop sent.
import { err, ok, type Result } from '@tripwire/result';
import type { Clock } from '../loop.js';
import type {
  ModelClient,
  ModelRequest,
  ModelResponse,
  ModelUsage,
  ResponseBlock,
} from '../model.js';
import type { TriageError } from '../triage.js';

export type ScriptStep =
  | ModelResponse
  | TriageError
  | ((
      request: ModelRequest,
      signal: AbortSignal | undefined,
    ) => Promise<Result<ModelResponse, TriageError>>);

export interface ScriptedModel extends ModelClient {
  /** Every request the loop made, in order. */
  readonly requests: ModelRequest[];
}

/** Answers each request with the next step. Running out of steps is a test bug. */
export function scriptedModel(steps: readonly ScriptStep[]): ScriptedModel {
  const requests: ModelRequest[] = [];
  return {
    requests,
    complete(request, { signal }) {
      // Copy: the loop's messages array is its own.
      requests.push({ ...request, messages: [...request.messages] });
      const step = steps[requests.length - 1];
      if (step === undefined)
        throw new Error(`no scripted answer for request ${String(requests.length)}`);
      if (typeof step === 'function') return step(request, signal);
      if ('kind' in step) return Promise.resolve(err(step));
      return Promise.resolve(ok(step));
    },
  };
}

export function usage(inputTokens: number, outputTokens: number): ModelUsage {
  return { inputTokens, outputTokens, cacheWriteTokens: 0, cacheReadTokens: 0 };
}

/** A turn that calls tools. */
export function toolUse(
  calls: readonly { readonly name: string; readonly input: unknown }[],
  tokens: ModelUsage = usage(1_000, 100),
): ModelResponse {
  return {
    content: [
      { type: 'opaque', block: { type: 'thinking', thinking: '', signature: 'sig-tools' } },
      ...calls.map((call, index): ResponseBlock => ({
        type: 'tool_use',
        id: `toolu_${call.name}_${String(index)}`,
        name: call.name,
        input: call.input,
      })),
    ],
    stopReason: 'tool_use',
    usage: tokens,
  };
}

/** A turn that answers with text: the report, as JSON, or anything else. */
export function answer(report: unknown, tokens: ModelUsage = usage(2_000, 300)): ModelResponse {
  return {
    content: [
      { type: 'opaque', block: { type: 'thinking', thinking: '', signature: 'sig-answer' } },
      { type: 'text', text: typeof report === 'string' ? report : JSON.stringify(report) },
    ],
    stopReason: 'end_turn',
    usage: tokens,
  };
}

/** A model call that never answers until it is aborted (by a deadline or a cancelled job). */
export function hang(): ScriptStep {
  return (_request, signal) =>
    new Promise((resolve) => {
      signal?.addEventListener('abort', () => {
        resolve(err({ kind: 'timeout', message: 'triage was cancelled' }));
      });
    });
}

export interface ManualClock extends Clock {
  /** Moves time on, firing any timers that fall due. */
  advance(ms: number): void;
}

export function manualClock(start = 0): ManualClock {
  let now = start;
  const timers = new Set<{ at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimer(ms, fn) {
      const timer = { at: now + ms, fn };
      timers.add(timer);
      return () => timers.delete(timer);
    },
    advance(ms) {
      now += ms;
      for (const timer of [...timers].sort((a, b) => a.at - b.at)) {
        if (timer.at <= now) {
          timers.delete(timer);
          timer.fn();
        }
      }
    },
  };
}
