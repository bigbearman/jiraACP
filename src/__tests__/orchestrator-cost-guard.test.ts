/**
 * Token usage and the cost guard through the real orchestrator, cost guard and
 * state file. Only the CLI boundary (runAgent) and external clients are
 * mocked; the mocked agent reports usage the way runAgent does.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProjectConfig } from "../config/schema.js";
import type { RunAgentOptions } from "../pipeline/runner.js";
import type { AgentCallUsage } from "../pipeline/token-usage.js";

const HAIKU = "claude-haiku-4-5-20251001";

// 1M input tokens on Haiku = $1.00 at $1/MTok
const ONE_DOLLAR_CALL: AgentCallUsage = {
  byModel: {
    [HAIKU]: {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    },
  },
  cliReportedCostUsd: 1,
};

const mockRunAgent = vi.fn(async (opts: RunAgentOptions): Promise<string> => {
  opts.usage?.record(ONE_DOLLAR_CALL);
  return '{"score":0.9,"missing":[],"questions":[]}';
});

const mockTelegram = {
  send: vi.fn().mockResolvedValue(1),
  sendError: vi.fn().mockResolvedValue(undefined),
  sendDone: vi.fn().mockResolvedValue(undefined),
  notifyStageStarted: vi.fn().mockResolvedValue(undefined),
  notifyStageCompleted: vi.fn().mockResolvedValue(undefined),
  notifyStageFailed: vi.fn().mockResolvedValue(undefined),
  notifyStageSkipped: vi.fn().mockResolvedValue(undefined),
  updateDetail: vi.fn().mockResolvedValue(undefined),
};

vi.mock("../integrations/jira/client.js", () => ({
  getClientFromConfig: vi.fn(() => ({
    get: vi.fn(),
    post: vi.fn().mockResolvedValue({ data: {} }),
    put: vi.fn().mockResolvedValue({ data: {} }),
  })),
}));
vi.mock("../integrations/github/client.js", () => ({
  createGitHubClient: vi.fn(() => ({})),
}));
vi.mock("../integrations/telegram/notifier.js", () => ({
  createTelegramNotifier: vi.fn(() => mockTelegram),
}));
vi.mock("../integrations/telegram/bot.js", () => ({
  initBot: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../pipeline/runner.js", () => ({
  runAgent: mockRunAgent,
  runAgentsParallel: vi.fn(),
  detectComplexity: vi.fn((_: string, base: string) => base),
}));
vi.mock("../utils/process.js", () => ({
  spawnSafe: vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 }),
  buildMinimalEnv: vi.fn().mockReturnValue({}),
}));
vi.mock("../integrations/telegram/human-loop.js", () => ({
  requestClarification: vi.fn().mockResolvedValue("answer"),
  requestApproval: vi.fn().mockResolvedValue(true),
}));

const PROJECT = "cost-test";
let tmpHome: string;

type Event = { type: string; stage?: string; [key: string]: unknown };

function runDir(ticketKey: string): string {
  return path.join(tmpHome, ".jira-acp", "runs", PROJECT, ticketKey);
}

/** Seed a finished fetch stage so the run can start at analyze. */
function seedFetched(ticketKey: string): void {
  const dir = runDir(ticketKey);
  fs.mkdirSync(path.join(dir, "memory"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "memory", "ticket-context.md"),
    "## Summary\nAdd a button\n",
  );
  const ts = new Date().toISOString();
  fs.writeFileSync(
    path.join(dir, "state.json"),
    [
      { type: "STARTED", ticketKey, timestamp: ts },
      { type: "STAGE_COMPLETED", stage: "fetch", output: {}, timestamp: ts },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n") + "\n",
  );
}

function readEvents(ticketKey: string): Event[] {
  return fs
    .readFileSync(path.join(runDir(ticketKey), "state.json"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Event);
}

function makeConfig(maxCostUsdPerRun?: number): ProjectConfig {
  return {
    name: PROJECT,
    jira: {
      instance: "hi",
      url: "https://test.atlassian.net",
      email: "dev@test.com",
      token: "t",
      projectKey: "CF",
      assignees: [],
      acceptanceCriteriaField: "customfield_10014",
    },
    github: { owner: "org", repo: "repo", token: "ghp", defaultBranch: "main" },
    workspace: { rootDir: tmpHome },
    telegram: { botToken: "123:ABC", chatId: "-100" },
    pipeline: { maxCostUsdPerRun },
  } as unknown as ProjectConfig;
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "cost-guard-flow-"));
  vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
  vi.clearAllMocks();
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  vi.resetModules();
  process.exitCode = undefined;
});

describe("token usage on stage events", () => {
  it("records tokenUsage and the real model on STAGE_COMPLETED", async () => {
    seedFetched("CF-TU1");
    const { runPipeline } = await import("../pipeline/orchestrator.js");
    await runPipeline("CF-TU1", makeConfig(), {
      fromStage: "analyze",
      toStage: "analyze",
    });

    const analyze = readEvents("CF-TU1").find(
      (e) => e.type === "STAGE_COMPLETED" && e.stage === "analyze",
    );
    expect(analyze?.output).toMatchObject({
      score: 0.9,
      tokenUsage: {
        model: HAIKU,
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        calls: 1,
        cliReportedCostUsd: 1,
      },
    });
    const { tokenUsage } = analyze?.output as { tokenUsage: { costUsd: number } };
    expect(tokenUsage.costUsd).toBeCloseTo(1);
  });

  it("does not add tokenUsage to a stage that made no LLM call", async () => {
    seedFetched("CF-TU2");
    const { runPipeline } = await import("../pipeline/orchestrator.js");
    // A dry-run code stage completes without calling the agent
    await runPipeline("CF-TU2", makeConfig(), {
      fromStage: "code",
      toStage: "code",
      dryRun: true,
    });

    const code = readEvents("CF-TU2").find(
      (e) => e.type === "STAGE_COMPLETED" && e.stage === "code",
    );
    expect(code?.output).toHaveProperty("branchName");
    expect(code?.output).not.toHaveProperty("tokenUsage");
    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  it("records tokenUsage on STAGE_FAILED when the stage spent tokens", async () => {
    seedFetched("CF-TU3");
    mockRunAgent.mockImplementationOnce(async (opts) => {
      opts.usage?.record(ONE_DOLLAR_CALL);
      throw new Error("Agent exited with code 1");
    });

    const { runPipeline } = await import("../pipeline/orchestrator.js");
    await runPipeline("CF-TU3", makeConfig(), {
      fromStage: "analyze",
      toStage: "analyze",
    });

    const failed = readEvents("CF-TU3").find((e) => e.type === "STAGE_FAILED");
    expect(failed?.stage).toBe("analyze");
    expect(failed?.tokenUsage).toMatchObject({ model: HAIKU, calls: 1 });
  });
});

describe("cost guard", () => {
  it("aborts the run once a stage pushes cost over the limit", async () => {
    seedFetched("CF-CG1");
    const { runPipeline } = await import("../pipeline/orchestrator.js");
    await runPipeline("CF-CG1", makeConfig(0.5), { fromStage: "analyze" });

    const events = readEvents("CF-CG1");
    const runEvents = events.slice(
      events.map((e) => e.type).lastIndexOf("STARTED"),
    );

    // analyze completed, then the guard stopped the run before clarify
    expect(
      runEvents.some(
        (e) => e.type === "STAGE_COMPLETED" && e.stage === "analyze",
      ),
    ).toBe(true);
    expect(
      runEvents.some((e) => e.type === "STAGE_STARTED" && e.stage === "clarify"),
    ).toBe(false);

    // Recorded once, and the completed stage is not marked failed
    const aborted = runEvents.filter((e) => e.type === "PIPELINE_ABORTED");
    expect(aborted).toHaveLength(1);
    expect(String(aborted[0].reason)).toMatch(/^Cost limit exceeded/);
    expect(runEvents.some((e) => e.type === "STAGE_FAILED")).toBe(false);

    expect(mockTelegram.send).toHaveBeenCalledWith(
      expect.stringContaining("Cost limit reached"),
    );
    expect(mockTelegram.sendError).toHaveBeenCalled();
  });

  it("lets the run continue while cost stays under the limit", async () => {
    seedFetched("CF-CG2");
    const { runPipeline } = await import("../pipeline/orchestrator.js");
    await runPipeline("CF-CG2", makeConfig(5), {
      fromStage: "analyze",
      toStage: "analyze",
    });

    const types = readEvents("CF-CG2").map((e) => e.type);
    expect(types).toContain("PIPELINE_COMPLETED");
    expect(types).not.toContain("PIPELINE_ABORTED");
  });
});
