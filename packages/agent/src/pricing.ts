import type { ModelUsage } from './model.js';

// USD per million tokens. Source: https://platform.claude.com/docs/en/about-claude/pricing, read
// on PRICE_SHEET_DATE (5-minute cache writes; the loop's cache breakpoints use the default 5-minute
// TTL). Prices change: check the page before trusting a cost figure, or override per deployment.

/** When MODEL_PRICING was read from the price sheet: every reported cost is at these prices. */
export const PRICE_SHEET_DATE = '2026-10-12';

export interface ModelPricing {
  readonly inputUsdPerMTok: number;
  readonly cacheWriteUsdPerMTok: number;
  readonly cacheReadUsdPerMTok: number;
  readonly outputUsdPerMTok: number;
}

export const MODEL_PRICING: Readonly<Record<string, ModelPricing>> = {
  'claude-fable-5-1': {
    inputUsdPerMTok: 10,
    cacheWriteUsdPerMTok: 12.5,
    cacheReadUsdPerMTok: 0.25,
    outputUsdPerMTok: 50,
  },
  'claude-opus-5-5': {
    inputUsdPerMTok: 4,
    cacheWriteUsdPerMTok: 5,
    cacheReadUsdPerMTok: 0.2,
    outputUsdPerMTok: 20,
  },
  'claude-sonnet-5-5': {
    inputUsdPerMTok: 2,
    cacheWriteUsdPerMTok: 2.5,
    cacheReadUsdPerMTok: 0.1,
    outputUsdPerMTok: 10,
  },
  // Prompts up to 100k tokens, which a triage run's 40k budget always is.
  'claude-haiku-5-5': {
    inputUsdPerMTok: 0.1,
    cacheWriteUsdPerMTok: 0.125,
    cacheReadUsdPerMTok: 0.01,
    outputUsdPerMTok: 0.5,
  },
};

export function pricingFor(model: string): ModelPricing | undefined {
  return MODEL_PRICING[model];
}

/** Cost in micro-dollars: USD per million tokens × tokens. */
export function costUsdMicros(usage: ModelUsage, pricing: ModelPricing | undefined): number {
  if (!pricing) return 0;
  const uncached = usage.inputTokens - usage.cacheWriteTokens - usage.cacheReadTokens;
  return Math.round(
    uncached * pricing.inputUsdPerMTok +
      usage.cacheWriteTokens * pricing.cacheWriteUsdPerMTok +
      usage.cacheReadTokens * pricing.cacheReadUsdPerMTok +
      usage.outputTokens * pricing.outputUsdPerMTok,
  );
}
