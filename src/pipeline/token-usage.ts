import { estimateCostUsd, type ModelTokenUsage } from "../utils/pricing.js";

/** Per-model usage of one CLI call. `cliCostUsd` is the CLI's own estimate. */
export interface CallModelUsage extends ModelTokenUsage {
  cliCostUsd?: number;
}

/** What one Claude CLI call consumed, parsed from its JSON result. */
export interface AgentCallUsage {
  byModel: Record<string, CallModelUsage>;
  cliReportedCostUsd?: number;
}

/**
 * Where a model's cost came from:
 * - `table`: src/utils/pricing.ts
 * - `cli`: model missing from the table, so the CLI's own estimate is used
 * - `none`: neither was available; cost counted as 0
 */
export type PricingSource = "table" | "cli" | "none";

export interface ModelCost extends ModelTokenUsage {
  costUsd: number;
  pricing: PricingSource;
}

/**
 * Usage summed over every agent call one stage made. Stored as `tokenUsage`
 * on STAGE_COMPLETED and STAGE_FAILED events.
 */
export interface TokenUsage extends ModelTokenUsage {
  /** Model with the most tokens in this stage, as reported by the CLI */
  model: string;
  costUsd: number;
  calls: number;
  byModel: Record<string, ModelCost>;
  cliReportedCostUsd?: number;
}

/** Anything that accepts per-call usage; the runner only needs this much. */
export interface UsageSink {
  record(call: AgentCallUsage): void;
}

/** Collects agent calls for the stage that is running. */
export class UsageRecorder implements UsageSink {
  private calls: AgentCallUsage[] = [];

  record(call: AgentCallUsage): void {
    this.calls.push(call);
  }

  /** Sum everything recorded since the last drain, then reset. */
  drain(): TokenUsage | undefined {
    const calls = this.calls;
    this.calls = [];
    return summarizeCalls(calls);
  }
}

export interface ParsedAgentResult {
  text: string;
  isError: boolean;
  subtype?: string;
  usage: AgentCallUsage | null;
}

/**
 * Parse stdout of `claude --print --output-format json`. Returns null when
 * stdout is not a JSON object, e.g. an older CLI that ignored the flag.
 */
export function parseAgentResult(
  stdout: string,
  requestedModel: string,
): ParsedAgentResult | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  return {
    text: typeof parsed["result"] === "string" ? parsed["result"].trim() : "",
    isError: parsed["is_error"] === true,
    subtype:
      typeof parsed["subtype"] === "string" ? parsed["subtype"] : undefined,
    usage: parseCallUsage(parsed, requestedModel),
  };
}

function parseCallUsage(
  result: Record<string, unknown>,
  requestedModel: string,
): AgentCallUsage | null {
  const cliReportedCostUsd = optionalNumber(result["total_cost_usd"]);
  const byModel: Record<string, CallModelUsage> = {};

  // modelUsage covers subagents and side calls too, keyed by real model ID
  const modelUsage = result["modelUsage"];
  if (isRecord(modelUsage)) {
    for (const [model, raw] of Object.entries(modelUsage)) {
      if (!isRecord(raw)) continue;
      byModel[model] = {
        inputTokens: count(raw["inputTokens"]),
        outputTokens: count(raw["outputTokens"]),
        cacheCreationInputTokens: count(raw["cacheCreationInputTokens"]),
        cacheReadInputTokens: count(raw["cacheReadInputTokens"]),
        cliCostUsd: optionalNumber(raw["costUSD"]),
      };
    }
  }

  // Fallback: top-level usage only covers the main loop and has no model name
  const usage = result["usage"];
  if (Object.keys(byModel).length === 0 && isRecord(usage)) {
    byModel[requestedModel] = {
      inputTokens: count(usage["input_tokens"]),
      outputTokens: count(usage["output_tokens"]),
      cacheCreationInputTokens: count(usage["cache_creation_input_tokens"]),
      cacheReadInputTokens: count(usage["cache_read_input_tokens"]),
      cliCostUsd: cliReportedCostUsd,
    };
  }

  if (Object.keys(byModel).length === 0) return null;
  return { byModel, cliReportedCostUsd };
}

export function summarizeCalls(
  calls: AgentCallUsage[],
): TokenUsage | undefined {
  if (calls.length === 0) return undefined;

  const tokens: Record<string, CallModelUsage> = {};
  let cliReportedCostUsd: number | undefined;
  for (const call of calls) {
    if (call.cliReportedCostUsd !== undefined) {
      cliReportedCostUsd = (cliReportedCostUsd ?? 0) + call.cliReportedCostUsd;
    }
    for (const [model, u] of Object.entries(call.byModel)) {
      const acc = (tokens[model] ??= emptyTokens());
      acc.inputTokens += u.inputTokens;
      acc.outputTokens += u.outputTokens;
      acc.cacheCreationInputTokens += u.cacheCreationInputTokens;
      acc.cacheReadInputTokens += u.cacheReadInputTokens;
      if (u.cliCostUsd !== undefined) {
        acc.cliCostUsd = (acc.cliCostUsd ?? 0) + u.cliCostUsd;
      }
    }
  }

  const byModel: Record<string, ModelCost> = {};
  for (const [model, { cliCostUsd, ...u }] of Object.entries(tokens)) {
    byModel[model] = { ...u, ...priceModel(u, model, cliCostUsd) };
  }

  const summary = totalsOf(byModel);
  return {
    ...summary,
    calls: calls.length,
    byModel,
    ...(cliReportedCostUsd !== undefined ? { cliReportedCostUsd } : {}),
  };
}

function priceModel(
  usage: ModelTokenUsage,
  model: string,
  cliCostUsd: number | undefined,
): { costUsd: number; pricing: PricingSource } {
  const fromTable = estimateCostUsd(usage, model);
  if (fromTable !== null) return { costUsd: fromTable, pricing: "table" };
  if (cliCostUsd !== undefined) return { costUsd: cliCostUsd, pricing: "cli" };
  return { costUsd: 0, pricing: "none" };
}

function totalsOf(
  byModel: Record<string, ModelCost>,
): ModelTokenUsage & { model: string; costUsd: number } {
  const total = { ...emptyTokens(), model: "unknown", costUsd: 0 };
  let topTokens = -1;
  for (const [model, u] of Object.entries(byModel)) {
    total.inputTokens += u.inputTokens;
    total.outputTokens += u.outputTokens;
    total.cacheCreationInputTokens += u.cacheCreationInputTokens;
    total.cacheReadInputTokens += u.cacheReadInputTokens;
    total.costUsd += u.costUsd;
    const modelTokens =
      u.inputTokens +
      u.outputTokens +
      u.cacheCreationInputTokens +
      u.cacheReadInputTokens;
    if (modelTokens > topTokens) {
      topTokens = modelTokens;
      total.model = model;
    }
  }
  return total;
}

/**
 * Read `tokenUsage` from an event payload. Accepts the current shape and the
 * older `{ inputTokens, outputTokens, model }` shape (priced from the table).
 * Returns null when absent or malformed.
 */
export function extractTokenUsage(output: unknown): TokenUsage | null {
  if (!isRecord(output)) return null;
  const tu = output["tokenUsage"];
  if (!isRecord(tu)) return null;
  if (
    typeof tu["inputTokens"] !== "number" ||
    typeof tu["outputTokens"] !== "number"
  ) {
    return null;
  }

  const model = typeof tu["model"] === "string" ? tu["model"] : "unknown";
  const usage: ModelTokenUsage = {
    inputTokens: tu["inputTokens"],
    outputTokens: tu["outputTokens"],
    cacheCreationInputTokens: count(tu["cacheCreationInputTokens"]),
    cacheReadInputTokens: count(tu["cacheReadInputTokens"]),
  };

  const byModel: Record<string, ModelCost> = {};
  if (isRecord(tu["byModel"])) {
    for (const [m, raw] of Object.entries(tu["byModel"])) {
      if (!isRecord(raw)) continue;
      const mu: ModelTokenUsage = {
        inputTokens: count(raw["inputTokens"]),
        outputTokens: count(raw["outputTokens"]),
        cacheCreationInputTokens: count(raw["cacheCreationInputTokens"]),
        cacheReadInputTokens: count(raw["cacheReadInputTokens"]),
      };
      byModel[m] =
        typeof raw["costUsd"] === "number"
          ? { ...mu, costUsd: raw["costUsd"], pricing: pricingOf(raw) }
          : { ...mu, ...priceModel(mu, m, undefined) };
    }
  }
  if (Object.keys(byModel).length === 0) {
    byModel[model] = { ...usage, ...priceModel(usage, model, undefined) };
  }

  // Keep the cost recorded at run time; prices may have changed since
  const costUsd =
    typeof tu["costUsd"] === "number"
      ? tu["costUsd"]
      : Object.values(byModel).reduce((sum, m) => sum + m.costUsd, 0);

  const cliReportedCostUsd = optionalNumber(tu["cliReportedCostUsd"]);
  return {
    ...usage,
    model,
    costUsd,
    calls: count(tu["calls"]) || 1,
    byModel,
    ...(cliReportedCostUsd !== undefined ? { cliReportedCostUsd } : {}),
  };
}

function pricingOf(raw: Record<string, unknown>): PricingSource {
  const p = raw["pricing"];
  return p === "table" || p === "cli" || p === "none" ? p : "table";
}

function emptyTokens(): ModelTokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}
