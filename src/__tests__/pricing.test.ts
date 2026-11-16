import { describe, it, expect } from "vitest";
import {
  estimateCostUsd,
  extractTokenUsage,
  MODEL_PRICING,
} from "../utils/pricing.js";

describe("estimateCostUsd", () => {
  it("calculates cost for known model", () => {
    // haiku: $0.8 input + $4.0 output per 1M tokens
    const cost = estimateCostUsd(1_000_000, 1_000_000, "claude-haiku-4-5");
    expect(cost).toBeCloseTo(4.8);
  });

  it("calculates cost for sonnet", () => {
    const cost = estimateCostUsd(500_000, 200_000, "claude-sonnet-4-5");
    // (0.5 * 3.0) + (0.2 * 15.0) = 1.5 + 3.0 = 4.5
    expect(cost).toBeCloseTo(4.5);
  });

  it("falls back to default pricing for unknown model", () => {
    const defaultCost = estimateCostUsd(1_000_000, 1_000_000, "unknown-model");
    const sonnetCost = estimateCostUsd(1_000_000, 1_000_000, "claude-sonnet-4");
    expect(defaultCost).toBeCloseTo(sonnetCost);
  });

  it("returns 0 for zero tokens", () => {
    expect(estimateCostUsd(0, 0, "claude-haiku-4-5")).toBe(0);
  });

  it("handles fractional token counts", () => {
    const cost = estimateCostUsd(100, 100, "claude-haiku-4-5");
    expect(cost).toBeGreaterThan(0);
    expect(cost).toBeLessThan(0.01);
  });

  it("all models in MODEL_PRICING have positive prices", () => {
    for (const [model, pricing] of Object.entries(MODEL_PRICING)) {
      expect(pricing.inputPer1M, `${model} inputPer1M`).toBeGreaterThan(0);
      expect(pricing.outputPer1M, `${model} outputPer1M`).toBeGreaterThan(0);
    }
  });
});

describe("extractTokenUsage", () => {
  it("extracts valid token usage", () => {
    const output = {
      tokenUsage: {
        inputTokens: 100,
        outputTokens: 200,
        model: "claude-haiku-4-5",
      },
    };
    expect(extractTokenUsage(output)).toEqual({
      inputTokens: 100,
      outputTokens: 200,
      model: "claude-haiku-4-5",
    });
  });

  it("defaults model to claude-sonnet-4 if missing", () => {
    const output = { tokenUsage: { inputTokens: 100, outputTokens: 200 } };
    expect(extractTokenUsage(output)?.model).toBe("claude-sonnet-4");
  });

  it("returns null for null input", () => {
    expect(extractTokenUsage(null)).toBeNull();
  });

  it("returns null for non-object input", () => {
    expect(extractTokenUsage("string")).toBeNull();
    expect(extractTokenUsage(42)).toBeNull();
  });

  it("returns null when tokenUsage is missing", () => {
    expect(extractTokenUsage({ other: "field" })).toBeNull();
  });

  it("returns null when inputTokens is not a number", () => {
    const output = { tokenUsage: { inputTokens: "100", outputTokens: 200 } };
    expect(extractTokenUsage(output)).toBeNull();
  });

  it("returns null when outputTokens is not a number", () => {
    const output = { tokenUsage: { inputTokens: 100, outputTokens: null } };
    expect(extractTokenUsage(output)).toBeNull();
  });
});
