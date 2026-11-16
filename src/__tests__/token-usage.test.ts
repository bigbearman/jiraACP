import { describe, it, expect } from "vitest";
import {
  extractTokenUsage,
  parseAgentResult,
  summarizeCalls,
  UsageRecorder,
} from "../pipeline/token-usage.js";

const HAIKU = "claude-haiku-4-5-20251001";
const SONNET = "claude-sonnet-4-6";

/** Shape of `claude --print --output-format json` stdout */
function cliResult(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "  agent answer  ",
    session_id: "s-1",
    total_cost_usd: 0.0123,
    usage: {
      input_tokens: 10,
      output_tokens: 20,
      cache_creation_input_tokens: 30,
      cache_read_input_tokens: 40,
    },
    modelUsage: {
      [SONNET]: {
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadInputTokens: 2000,
        cacheCreationInputTokens: 300,
        costUSD: 0.012,
      },
      [HAIKU]: {
        inputTokens: 100,
        outputTokens: 10,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        costUSD: 0.0003,
      },
    },
    ...overrides,
  });
}

describe("parseAgentResult", () => {
  it("reads text, error flag and per-model usage", () => {
    const parsed = parseAgentResult(cliResult(), SONNET);
    expect(parsed?.text).toBe("agent answer");
    expect(parsed?.isError).toBe(false);
    expect(parsed?.usage?.cliReportedCostUsd).toBe(0.0123);
    expect(parsed?.usage?.byModel[SONNET]).toEqual({
      inputTokens: 1000,
      outputTokens: 500,
      cacheCreationInputTokens: 300,
      cacheReadInputTokens: 2000,
      cliCostUsd: 0.012,
    });
    expect(Object.keys(parsed?.usage?.byModel ?? {})).toEqual([SONNET, HAIKU]);
  });

  it("falls back to top-level usage under the requested model", () => {
    const parsed = parseAgentResult(
      cliResult({ modelUsage: undefined }),
      SONNET,
    );
    expect(parsed?.usage?.byModel).toEqual({
      [SONNET]: {
        inputTokens: 10,
        outputTokens: 20,
        cacheCreationInputTokens: 30,
        cacheReadInputTokens: 40,
        cliCostUsd: 0.0123,
      },
    });
  });

  it("reports is_error results", () => {
    const parsed = parseAgentResult(
      cliResult({ is_error: true, subtype: "error_max_turns", result: "" }),
      SONNET,
    );
    expect(parsed?.isError).toBe(true);
    expect(parsed?.subtype).toBe("error_max_turns");
    expect(parsed?.usage).not.toBeNull();
  });

  it("returns usage null when the result has no usage fields", () => {
    const parsed = parseAgentResult(
      JSON.stringify({ result: "hi", is_error: false }),
      SONNET,
    );
    expect(parsed?.text).toBe("hi");
    expect(parsed?.usage).toBeNull();
  });

  it("returns null for non-JSON stdout", () => {
    expect(parseAgentResult("plain text answer", SONNET)).toBeNull();
    expect(parseAgentResult("[1,2]", SONNET)).toBeNull();
  });
});

describe("summarizeCalls", () => {
  it("returns undefined when no calls were made", () => {
    expect(summarizeCalls([])).toBeUndefined();
  });

  it("sums calls per model and prices from the table", () => {
    const call = {
      byModel: {
        [SONNET]: {
          inputTokens: 1_000_000,
          outputTokens: 100_000,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        },
      },
      cliReportedCostUsd: 4.5,
    };
    const tu = summarizeCalls([call, call]);
    // 2 × (1M × $3 + 0.1M × $15) = 2 × 4.5
    expect(tu?.costUsd).toBeCloseTo(9);
    expect(tu?.inputTokens).toBe(2_000_000);
    expect(tu?.outputTokens).toBe(200_000);
    expect(tu?.calls).toBe(2);
    expect(tu?.model).toBe(SONNET);
    expect(tu?.byModel[SONNET].pricing).toBe("table");
    expect(tu?.cliReportedCostUsd).toBeCloseTo(9);
  });

  it("picks the model with the most tokens as the stage model", () => {
    const parsed = parseAgentResult(cliResult(), SONNET);
    const tu = summarizeCalls(parsed?.usage ? [parsed.usage] : []);
    expect(tu?.model).toBe(SONNET);
    expect(Object.keys(tu?.byModel ?? {})).toContain(HAIKU);
  });

  it("uses the CLI's cost for a model missing from the table", () => {
    const tu = summarizeCalls([
      {
        byModel: {
          "claude-future-9": {
            inputTokens: 10,
            outputTokens: 10,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
            cliCostUsd: 0.5,
          },
        },
      },
    ]);
    expect(tu?.costUsd).toBe(0.5);
    expect(tu?.byModel["claude-future-9"].pricing).toBe("cli");
  });

  it("marks an unknown model without a CLI cost as unpriced", () => {
    const tu = summarizeCalls([
      {
        byModel: {
          "claude-future-9": {
            inputTokens: 10,
            outputTokens: 10,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
          },
        },
      },
    ]);
    expect(tu?.costUsd).toBe(0);
    expect(tu?.byModel["claude-future-9"].pricing).toBe("none");
  });
});

describe("UsageRecorder", () => {
  it("drain returns the sum and resets", () => {
    const recorder = new UsageRecorder();
    expect(recorder.drain()).toBeUndefined();

    recorder.record({
      byModel: {
        [HAIKU]: {
          inputTokens: 5,
          outputTokens: 5,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        },
      },
    });
    expect(recorder.drain()?.inputTokens).toBe(5);
    expect(recorder.drain()).toBeUndefined();
  });
});

describe("extractTokenUsage", () => {
  it("round-trips a summary stored on an event", () => {
    const parsed = parseAgentResult(cliResult(), SONNET);
    const tu = summarizeCalls(parsed?.usage ? [parsed.usage] : []);
    const stored = JSON.parse(JSON.stringify({ tokenUsage: tu })) as unknown;
    expect(extractTokenUsage(stored)).toEqual(tu);
  });

  it("keeps the cost recorded at run time", () => {
    const out = extractTokenUsage({
      tokenUsage: {
        inputTokens: 1_000_000,
        outputTokens: 0,
        model: SONNET,
        costUsd: 123,
      },
    });
    expect(out?.costUsd).toBe(123);
  });

  it("prices the legacy { inputTokens, outputTokens, model } shape", () => {
    const out = extractTokenUsage({
      tokenUsage: { inputTokens: 1_000_000, outputTokens: 0, model: HAIKU },
    });
    expect(out?.costUsd).toBeCloseTo(1);
    expect(out?.cacheReadInputTokens).toBe(0);
    expect(out?.calls).toBe(1);
  });

  it("does not guess a model when none was stored", () => {
    const out = extractTokenUsage({
      tokenUsage: { inputTokens: 100, outputTokens: 200 },
    });
    expect(out?.model).toBe("unknown");
    expect(out?.costUsd).toBe(0);
    expect(out?.byModel["unknown"].pricing).toBe("none");
  });

  it.each([
    ["null", null],
    ["a string", "string"],
    ["a number", 42],
    ["no tokenUsage", { other: "field" }],
    ["string inputTokens", { tokenUsage: { inputTokens: "1", outputTokens: 2 } }],
    ["null outputTokens", { tokenUsage: { inputTokens: 1, outputTokens: null } }],
  ])("returns null for %s", (_label, value) => {
    expect(extractTokenUsage(value)).toBeNull();
  });
});
