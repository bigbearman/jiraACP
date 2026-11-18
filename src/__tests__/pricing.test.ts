import { describe, it, expect } from "vitest";
import {
  estimateCostUsd,
  getModelPricing,
  MODEL_PRICING,
} from "../utils/pricing.js";
import { MODEL_IDS } from "../pipeline/runner.js";

const tokens = (
  inputTokens: number,
  outputTokens: number,
  cacheCreationInputTokens = 0,
  cacheReadInputTokens = 0,
) => ({
  inputTokens,
  outputTokens,
  cacheCreationInputTokens,
  cacheReadInputTokens,
});

describe("MODEL_PRICING", () => {
  it("has a price for every model ID the runner sends", () => {
    for (const id of Object.values(MODEL_IDS)) {
      expect(getModelPricing(id), id).not.toBeNull();
    }
  });

  it("all prices are positive", () => {
    for (const [model, p] of Object.entries(MODEL_PRICING)) {
      expect(p.inputPer1M, `${model} input`).toBeGreaterThan(0);
      expect(p.outputPer1M, `${model} output`).toBeGreaterThan(0);
      expect(p.cacheWritePer1M, `${model} cache write`).toBeGreaterThan(0);
      expect(p.cacheReadPer1M, `${model} cache read`).toBeGreaterThan(0);
    }
  });

  // Pinned to https://platform.claude.com/docs/en/about-claude/pricing
  // (looked up 2026-11-16). Update both together.
  it.each([
    ["claude-haiku-4-5-20251001", 1, 5, 1.25, 0.1],
    ["claude-sonnet-4-6", 3, 15, 3.75, 0.3],
    ["claude-opus-4-6", 5, 25, 6.25, 0.5],
  ])("%s matches the published price", (id, input, output, write, read) => {
    expect(MODEL_PRICING[id]).toEqual({
      inputPer1M: input,
      outputPer1M: output,
      cacheWritePer1M: write,
      cacheReadPer1M: read,
    });
  });
});

describe("getModelPricing", () => {
  it("resolves the undated Haiku alias", () => {
    expect(getModelPricing("claude-haiku-4-5")).toBe(
      MODEL_PRICING["claude-haiku-4-5-20251001"],
    );
  });

  it("strips a context-window tag such as [1m]", () => {
    expect(getModelPricing("claude-sonnet-4-6[1m]")).toBe(
      MODEL_PRICING["claude-sonnet-4-6"],
    );
  });

  it("returns null for unknown models instead of borrowing a price", () => {
    expect(getModelPricing("claude-sonnet-4")).toBeNull();
    expect(getModelPricing("gpt-4")).toBeNull();
  });
});

describe("estimateCostUsd", () => {
  it("prices input and output", () => {
    // 1M × $3 + 1M × $15
    expect(
      estimateCostUsd(tokens(1_000_000, 1_000_000), "claude-sonnet-4-6"),
    ).toBeCloseTo(18);
  });

  it("prices cache writes and reads separately", () => {
    // Haiku: 1M cache write × $1.25 + 1M cache read × $0.10
    expect(
      estimateCostUsd(
        tokens(0, 0, 1_000_000, 1_000_000),
        "claude-haiku-4-5-20251001",
      ),
    ).toBeCloseTo(1.35);
  });

  it("returns 0 for zero tokens", () => {
    expect(estimateCostUsd(tokens(0, 0), "claude-opus-4-6")).toBe(0);
  });

  it("returns null for an unknown model", () => {
    expect(estimateCostUsd(tokens(100, 100), "unknown-model")).toBeNull();
  });
});
