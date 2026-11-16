import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pc from "picocolors";
import { getEvents, type PipelineEvent } from "../pipeline/state.js";
import { extractTokenUsage, type TokenUsage } from "../pipeline/token-usage.js";
import type { ModelTokenUsage } from "../utils/pricing.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("usage");

export interface UsageOptions {
  month?: string; // "YYYY-MM" format
  project?: string; // filter by project name
  ticket?: string; // filter by ticket key
  verbose?: boolean; // show per-stage breakdown under each ticket
}

export interface UsageTotals extends ModelTokenUsage {
  costUsd: number;
}

export interface StageUsage extends UsageTotals {
  /** Stage executions that recorded usage */
  executions: number;
  /** Agent (CLI) calls across those executions */
  calls: number;
}

export interface TicketUsage extends UsageTotals {
  runs: number;
  stages: Record<string, StageUsage>;
}

export interface ProjectUsage extends UsageTotals {
  runs: number;
  tickets: Record<string, TicketUsage>;
}

export interface UsageReport {
  projects: Record<string, ProjectUsage>;
  stages: Record<string, StageUsage>;
  total: UsageTotals & { runs: number };
  /** Models priced from the CLI's estimate or not at all */
  unpricedModels: string[];
}

const RUNS_DIR = path.join(os.homedir(), ".jira-acp", "runs");

/** Aggregate token usage from every run state under `runsDir`. */
export function collectUsage(
  runsDir: string,
  opts: Omit<UsageOptions, "verbose"> = {},
): UsageReport {
  const report: UsageReport = {
    projects: {},
    stages: {},
    total: { ...emptyTotals(), runs: 0 },
    unpricedModels: [],
  };
  const unpriced = new Set<string>();

  for (const projectName of listDirs(runsDir)) {
    if (opts.project && projectName !== opts.project) continue;
    const projectDir = path.join(runsDir, projectName);

    for (const ticketKey of listDirs(projectDir)) {
      if (ticketKey === "__triage__") continue;
      if (opts.ticket && ticketKey !== opts.ticket) continue;

      for (const run of splitRuns(getEvents(path.join(projectDir, ticketKey)))) {
        if (opts.month && run.startedAt.slice(0, 7) !== opts.month) continue;

        let runHasTokens = false;
        for (const { stage, tu } of stageUsages(run.events)) {
          runHasTokens = true;
          for (const [model, m] of Object.entries(tu.byModel)) {
            if (m.pricing !== "table") unpriced.add(model);
          }

          const project = (report.projects[projectName] ??= {
            ...emptyTotals(),
            runs: 0,
            tickets: {},
          });
          const ticket = (project.tickets[ticketKey] ??= {
            ...emptyTotals(),
            runs: 0,
            stages: {},
          });
          const ticketStage = (ticket.stages[stage] ??= emptyStage());
          const globalStage = (report.stages[stage] ??= emptyStage());

          for (const acc of [report.total, project, ticket]) addTotals(acc, tu);
          for (const acc of [ticketStage, globalStage]) {
            addTotals(acc, tu);
            acc.executions += 1;
            acc.calls += tu.calls;
          }
        }

        if (runHasTokens) {
          report.total.runs += 1;
          report.projects[projectName].runs += 1;
          report.projects[projectName].tickets[ticketKey].runs += 1;
        }
      }
    }
  }

  report.unpricedModels = [...unpriced].sort();
  return report;
}

/** Split an append-only event log into runs, one per STARTED event. */
function splitRuns(
  events: PipelineEvent[],
): Array<{ startedAt: string; events: PipelineEvent[] }> {
  const runs: Array<{ startedAt: string; events: PipelineEvent[] }> = [];
  for (const event of events) {
    if (event.type === "STARTED") {
      runs.push({ startedAt: event.timestamp, events: [] });
    } else {
      runs[runs.length - 1]?.events.push(event);
    }
  }
  return runs;
}

function stageUsages(
  events: PipelineEvent[],
): Array<{ stage: string; tu: TokenUsage }> {
  const out: Array<{ stage: string; tu: TokenUsage }> = [];
  for (const event of events) {
    const tu =
      event.type === "STAGE_COMPLETED"
        ? extractTokenUsage(event.output)
        : event.type === "STAGE_FAILED"
          ? extractTokenUsage(event)
          : null;
    if (tu && "stage" in event) out.push({ stage: event.stage, tu });
  }
  return out;
}

function listDirs(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((entry) => {
    try {
      return fs.statSync(path.join(dir, entry)).isDirectory();
    } catch {
      return false;
    }
  });
}

function emptyTotals(): UsageTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    costUsd: 0,
  };
}

function emptyStage(): StageUsage {
  return { ...emptyTotals(), executions: 0, calls: 0 };
}

function addTotals(acc: UsageTotals, tu: TokenUsage): void {
  acc.inputTokens += tu.inputTokens;
  acc.outputTokens += tu.outputTokens;
  acc.cacheCreationInputTokens += tu.cacheCreationInputTokens;
  acc.cacheReadInputTokens += tu.cacheReadInputTokens;
  acc.costUsd += tu.costUsd;
}

// ── Rendering ──────────────────────────────────────────────────────────────

const COL_NAME = 26;
const COL_COUNT = 6;
const COL_TOKENS = 13;
const COL_COST = 11;
const SEPARATOR_LEN = COL_NAME + COL_COUNT + COL_TOKENS * 4 + COL_COST;

function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

function formatCost(n: number): string {
  return `$${n.toFixed(4)}`;
}

function padEnd(s: string, len: number): string {
  return s.length >= len ? s : s + " ".repeat(len - s.length);
}

function padStart(s: string, len: number): string {
  return s.length >= len ? s : " ".repeat(len - s.length) + s;
}

function header(first: string, count: string): string {
  return pc.bold(
    "  " +
      padEnd(first, COL_NAME) +
      padStart(count, COL_COUNT) +
      padStart("Input", COL_TOKENS) +
      padStart("Output", COL_TOKENS) +
      padStart("Cache write", COL_TOKENS) +
      padStart("Cache read", COL_TOKENS) +
      padStart("Est. cost", COL_COST),
  );
}

function row(name: string, count: number, t: UsageTotals): string {
  return (
    "  " +
    padEnd(name, COL_NAME) +
    padStart(String(count), COL_COUNT) +
    padStart(formatNumber(t.inputTokens), COL_TOKENS) +
    padStart(formatNumber(t.outputTokens), COL_TOKENS) +
    padStart(formatNumber(t.cacheCreationInputTokens), COL_TOKENS) +
    padStart(formatNumber(t.cacheReadInputTokens), COL_TOKENS) +
    padStart(formatCost(t.costUsd), COL_COST)
  );
}

export function renderUsage(report: UsageReport, opts: UsageOptions): string {
  const separator = "  " + pc.dim("─".repeat(SEPARATOR_LEN));
  const lines: string[] = [];

  lines.push(
    "",
    `  ${pc.bold("jiraACP usage report")} — ${pc.cyan(opts.month ?? "all time")}`,
    "",
    header("Project / ticket", "Runs"),
    separator,
  );

  for (const [projectName, p] of Object.entries(report.projects)) {
    lines.push(pc.bold(row(projectName, p.runs, p)));
    for (const [ticketKey, t] of Object.entries(p.tickets)) {
      lines.push(row(`  ${ticketKey}`, t.runs, t));
      if (!opts.verbose) continue;
      for (const [stage, s] of Object.entries(t.stages)) {
        lines.push(pc.dim(row(`    ↳ ${stage}`, s.executions, s)));
      }
    }
  }

  lines.push(
    separator,
    pc.bold(row("TOTAL", report.total.runs, report.total)),
    "",
    header("Stage", "Execs"),
    separator,
  );

  for (const [stage, s] of Object.entries(report.stages)) {
    lines.push(row(stage, s.executions, s));
  }
  lines.push(separator, "");

  if (report.unpricedModels.length > 0) {
    lines.push(
      pc.yellow(
        `  Not in src/utils/pricing.ts (cost from the CLI's estimate, or 0): ${report.unpricedModels.join(", ")}`,
      ),
      "",
    );
  }

  return lines.join("\n") + "\n";
}

export async function showUsage(opts: UsageOptions): Promise<void> {
  log.debug({ opts }, "showUsage called");

  if (!fs.existsSync(RUNS_DIR)) {
    process.stdout.write("No runs directory found at ~/.jira-acp/runs/\n");
    return;
  }

  const report = collectUsage(RUNS_DIR, opts);
  if (report.total.runs === 0) {
    process.stdout.write(
      "No token usage data found. Stages record tokenUsage on STAGE_COMPLETED once they call the Claude CLI.\n",
    );
    return;
  }

  process.stdout.write(renderUsage(report, opts));
}
