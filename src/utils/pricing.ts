/** Token counts for one model, in the shape the Claude CLI reports them. */
export interface ModelTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

export interface ModelPricing {
  inputPer1M: number;
  outputPer1M: number;
  /** 5-minute cache write price */
  cacheWritePer1M: number;
  /** Cache hit and refresh price */
  cacheReadPer1M: number;
}

/**
 * USD per 1M tokens, Claude API (first-party), global routing, standard tier.
 *
 * Source: https://platform.claude.com/docs/en/about-claude/pricing
 * Looked up: 2026-11-16
 *
 * Only the model IDs that src/pipeline/runner.ts sends are listed. When a model
 * ID changes there, look up its price on that page and add it here. Do not copy
 * a price from a neighbouring model.
 *
 * Cache writes use the 5-minute rate: the Claude CLI defaults to the 5-minute
 * TTL with API-key auth and reports one `cacheCreationInputTokens` figure per
 * model, without a 5m/1h split.
 */
export const MODEL_PRICING: Record<string, ModelPricing> = {
  "claude-haiku-4-5-20251001": {
    inputPer1M: 1,
    outputPer1M: 5,
    cacheWritePer1M: 1.25,
    cacheReadPer1M: 0.1,
  },
  "claude-sonnet-4-6": {
    inputPer1M: 3,
    outputPer1M: 15,
    cacheWritePer1M: 3.75,
    cacheReadPer1M: 0.3,
  },
  "claude-opus-4-6": {
    inputPer1M: 5,
    outputPer1M: 25,
    cacheWritePer1M: 6.25,
    cacheReadPer1M: 0.5,
  },
};

/** Aliases the CLI may report for the dated IDs above. */
const MODEL_ALIASES: Record<string, string> = {
  "claude-haiku-4-5": "claude-haiku-4-5-20251001",
};

/**
 * Find the price for a model ID as reported by the CLI. Strips a trailing
 * context-window tag such as `[1m]`. Returns null for unknown models so the
 * caller decides what to do instead of silently using another model's price.
 */
export function getModelPricing(model: string): ModelPricing | null {
  const id = model.replace(/\[[^\]]*\]$/, "");
  return MODEL_PRICING[id] ?? MODEL_PRICING[MODEL_ALIASES[id] ?? ""] ?? null;
}

/** Cost in USD for the given usage, or null when the model has no known price. */
export function estimateCostUsd(
  usage: ModelTokenUsage,
  model: string,
): number | null {
  const pricing = getModelPricing(model);
  if (!pricing) return null;
  return (
    (usage.inputTokens * pricing.inputPer1M +
      usage.outputTokens * pricing.outputPer1M +
      usage.cacheCreationInputTokens * pricing.cacheWritePer1M +
      usage.cacheReadInputTokens * pricing.cacheReadPer1M) /
    1_000_000
  );
}
