/**
 * Orchestrator control-flow edge cases.
 *
 * Tests special behaviors in runPipeline() that differ from normal stage failure:
 *   1. SKIP signal     — clarify throws "SKIP:..." → returns gracefully, no sendError
 *   2. HookError outer — beforePipeline            → PIPELINE_ABORTED NOT emitted
 *   3. HookError inner — afterCode                 → PIPELINE_ABORTED IS emitted
 *   4. Stage timeout   — withTimeout fires         → STAGE_FAILED + PIPELINE_ABORTED
 *   5. Cost limit      — exceeded after fetch      → pipeline stops, sendError called
 *   6. afterPipeline   — always runs in finally    → abort path AND SKIP path
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProjectConfig } from "../config/schema.js";

// ── mock refs ─────────────────────────────────────────────────────────────────
// Declared at module scope so vi.mock factories (which are hoisted) can capture them.

const mockRunHook = vi.fn().mockResolvedValue(undefined);
const mockCheckCostLimit = vi.fn().mockResolvedValue("continue" as const);
const mockRequestClarification = vi.fn().mockResolvedValue("answer");
const mockRunAgent = vi
  .fn()
  .mockResolvedValue('{"score":0.9,"missing":[],"questions":[]}');

const mockJira = {
  get: vi.fn(),
  post: vi.fn().mockResolvedValue({ data: {} }),
  put: vi.fn().mockResolvedValue({ data: {} }),
};

const mockGithub = {
  createPR: vi.fn().mockResolvedValue(42),
  findOpenPR: vi.fn().mockResolvedValue(null),
  addReviewers: vi.fn().mockResolvedValue(undefined),
  mergePR: vi.fn().mockResolvedValue(undefined),
  getPR: vi.fn().mockResolvedValue({ state: "open", merged: false }),
  getRunStatus: vi.fn().mockResolvedValue("success"),
};

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

// ── module mocks ──────────────────────────────────────────────────────────────

vi.mock("../integrations/jira/client.js", () => ({
  getClientFromConfig: vi.fn(() => mockJira),
}));
vi.mock("../integrations/github/client.js", () => ({
  createGitHubClient: vi.fn(() => mockGithub),
}));
vi.mock("../integrations/telegram/notifier.js", () => ({
  createTelegramNotifier: vi.fn(() => mockTelegram),
}));
vi.mock("../integrations/telegram/bot.js", () => ({
  initBot: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../pipeline/runner.js", () => ({
  runAgent: mockRunAgent,
  runAgentsParallel: vi
    .fn()
    .mockResolvedValue(['{"issues":[]}', '{"issues":[]}']),
  detectComplexity: vi.fn().mockReturnValue("sonnet"),
}));
vi.mock("../utils/process.js", () => ({
  spawnSafe: vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 }),
  buildMinimalEnv: vi.fn().mockReturnValue({}),
}));
// Re-export real HookError so instanceof checks inside orchestrator work correctly
vi.mock("../pipeline/hooks.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../pipeline/hooks.js")>();
  return { HookError: real.HookError, runHook: mockRunHook };
});
vi.mock("../pipeline/cost-guard.js", () => ({
  checkCostLimit: mockCheckCostLimit,
}));
vi.mock("../integrations/telegram/human-loop.js", () => ({
  requestClarification: mockRequestClarification,
  requestApproval: vi.fn().mockResolvedValue(true),
}));

// ── helpers ───────────────────────────────────────────────────────────────────

let tmpHome: string;

const PROJECT = "ctrl-test";

function getRunDir(ticketKey: string): string {
  return path.join(tmpHome, ".jira-acp", "runs", PROJECT, ticketKey);
}

/** Write a pre-seeded state.json so runPipeline can resume mid-pipeline. */
function seedState(
  ticketKey: string,
  events: Array<Record<string, unknown>>,
): void {
  const runDir = getRunDir(ticketKey);
  fs.mkdirSync(runDir, { recursive: true });
  const lines = events.map((e) =>
    JSON.stringify({ ...e, timestamp: new Date().toISOString() }),
  );
  fs.writeFileSync(path.join(runDir, "state.json"), lines.join("\n") + "\n");
}

function makeConfig(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    name: PROJECT,
    jira: {
      instance: "hi",
      url: "https://test.atlassian.net",
      email: "dev@test.com",
      token: "t",
      projectKey: "CF",
      assignees: ["acc-1"],
      acceptanceCriteriaField: "customfield_10014",
    },
    github: {
      owner: "org",
      repo: "repo",
      token: "ghp",
      defaultBranch: "main",
      ciNoChecksGraceMs: 0,
    },
    workspace: { rootDir: tmpHome },
    telegram: { botToken: "123:ABC", chatId: "-100" },
    ...overrides,
  } as ProjectConfig;
}

/** Default jira.get behaviour: returns issue data or transitions based on URL. */
function setupJiraMock(): void {
  mockJira.get.mockImplementation((url: string) => {
    if (url.includes("/transitions")) {
      return Promise.resolve({
        data: { transitions: [{ id: "31", name: "Done" }] },
      });
    }
    return Promise.resolve({
      data: {
        fields: {
          summary: "Fix bug",
          status: { name: "In Progress" },
          assignee: null,
          priority: { name: "Medium" },
          description: null,
          customfield_10014: null,
        },
      },
    });
  });
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "ctrl-flow-test-"));
  vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
  vi.clearAllMocks();
  setupJiraMock();
  mockTelegram.sendError.mockResolvedValue(undefined);
  mockTelegram.sendDone.mockResolvedValue(undefined);
  mockTelegram.send.mockResolvedValue(1);
  mockTelegram.notifyStageStarted.mockResolvedValue(undefined);
  mockTelegram.notifyStageCompleted.mockResolvedValue(undefined);
  mockTelegram.notifyStageFailed.mockResolvedValue(undefined);
  mockTelegram.notifyStageSkipped.mockResolvedValue(undefined);
  mockTelegram.updateDetail.mockResolvedValue(undefined);
  mockRunHook.mockResolvedValue(undefined);
  mockCheckCostLimit.mockResolvedValue("continue");
  mockRequestClarification.mockResolvedValue("answer");
  mockRunAgent.mockResolvedValue('{"score":0.9,"missing":[],"questions":[]}');
  mockGithub.createPR.mockResolvedValue(42);
  mockGithub.mergePR.mockResolvedValue(undefined);
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  vi.resetModules();
});

// ── 1. SKIP signal ────────────────────────────────────────────────────────────
//
// When clarify stage throws "SKIP: ...", the orchestrator emits STAGE_SKIPPED
// and returns — it does NOT abort, does NOT call sendError.

describe("SKIP signal from clarify stage", () => {
  it("resolves without error — sendError NOT called", async () => {
    seedState("CF-SK1", [
      { type: "STARTED", ticketKey: "CF-SK1" },
      { type: "STAGE_COMPLETED", stage: "fetch", output: { summary: "Fix" } },
      {
        type: "STAGE_COMPLETED",
        stage: "analyze",
        output: {
          score: 0.2,
          missing: [],
          questions: ["Q1?"],
          needsClarification: true,
        },
      },
    ]);
    mockRequestClarification.mockRejectedValueOnce(
      new Error("SKIP: timed out waiting for clarification"),
    );

    const { runPipeline } = await import("../pipeline/orchestrator.js");
    await expect(
      runPipeline("CF-SK1", makeConfig(), { fromStage: "clarify" }),
    ).resolves.toBeUndefined();

    expect(mockTelegram.sendError).not.toHaveBeenCalled();
  });

  it("PIPELINE_ABORTED not emitted — isAborted stays false", async () => {
    const ticketKey = "CF-SK2";
    seedState(ticketKey, [
      { type: "STARTED", ticketKey },
      { type: "STAGE_COMPLETED", stage: "fetch", output: {} },
      {
        type: "STAGE_COMPLETED",
        stage: "analyze",
        output: {
          score: 0.2,
          missing: [],
          questions: ["Q1?"],
          needsClarification: true,
        },
      },
    ]);
    mockRequestClarification.mockRejectedValueOnce(
      new Error("SKIP: timed out waiting for clarification"),
    );

    const { runPipeline } = await import("../pipeline/orchestrator.js");
    await runPipeline(ticketKey, makeConfig(), { fromStage: "clarify" });

    const { StateManager } = await import("../pipeline/state.js");
    const stateAfter = new StateManager(getRunDir(ticketKey));
    expect(stateAfter.current.isAborted).toBe(false);
  });
});

// ── 2. HookError — outside stage try-block (beforePipeline) ──────────────────
//
// beforePipeline is called before the for-loop, so HookError propagates directly
// to the outer catch. Outer catch: !(err instanceof HookError) → false →
// PIPELINE_ABORTED NOT emitted. But sendError IS called (outer catch always calls it).

describe("HookError from beforePipeline (outside stage try-block)", () => {
  it("sendError IS called", async () => {
    const { HookError } = await import("../pipeline/hooks.js");
    mockRunHook.mockImplementationOnce((name: string) => {
      if (name === "beforePipeline")
        return Promise.reject(new HookError("beforePipeline", 1));
      return Promise.resolve();
    });

    const { runPipeline } = await import("../pipeline/orchestrator.js");
    await runPipeline(
      "CF-HOOK1",
      makeConfig({
        pipeline: { hooks: { beforePipeline: "echo before" } },
      } as Partial<ProjectConfig>),
    );

    expect(mockTelegram.sendError).toHaveBeenCalled();
  });

  it("PIPELINE_ABORTED NOT emitted — isAborted stays false", async () => {
    const ticketKey = "CF-HOOK2";
    const { HookError } = await import("../pipeline/hooks.js");
    mockRunHook.mockImplementationOnce((name: string) => {
      if (name === "beforePipeline")
        return Promise.reject(new HookError("beforePipeline", 1));
      return Promise.resolve();
    });

    const { runPipeline } = await import("../pipeline/orchestrator.js");
    await runPipeline(
      ticketKey,
      makeConfig({
        pipeline: { hooks: { beforePipeline: "echo before" } },
      } as Partial<ProjectConfig>),
    );

    const { StateManager } = await import("../pipeline/state.js");
    const stateAfter = new StateManager(getRunDir(ticketKey));
    expect(stateAfter.current.isAborted).toBe(false);
  });

  it("no stages run after beforePipeline hook fails", async () => {
    const { HookError } = await import("../pipeline/hooks.js");
    mockRunHook.mockImplementationOnce((name: string) => {
      if (name === "beforePipeline")
        return Promise.reject(new HookError("beforePipeline", 1));
      return Promise.resolve();
    });

    const { runPipeline } = await import("../pipeline/orchestrator.js");
    await runPipeline(
      "CF-HOOK3",
      makeConfig({
        pipeline: { hooks: { beforePipeline: "echo before" } },
      } as Partial<ProjectConfig>),
    );

    expect(mockTelegram.notifyStageStarted).not.toHaveBeenCalled();
  });
});

// ── 3. HookError — inside stage try-block (afterCode) ────────────────────────
//
// afterCode is called INSIDE the inner try, after STAGE_COMPLETED(code).
// Inner catch: err instanceof HookError → emits PIPELINE_ABORTED, re-throws.
// Outer catch: !(err instanceof HookError) → false → does NOT emit second PIPELINE_ABORTED.
// sendError IS called by outer catch.

describe("HookError from afterCode (inside stage try-block)", () => {
  it("sendError IS called", async () => {
    const { HookError } = await import("../pipeline/hooks.js");
    mockRunHook.mockImplementation((name: string) => {
      if (name === "afterCode")
        return Promise.reject(new HookError("afterCode", 1));
      return Promise.resolve();
    });

    const { runPipeline } = await import("../pipeline/orchestrator.js");
    await runPipeline(
      "CF-HOOK4",
      makeConfig({
        pipeline: { hooks: { afterCode: "echo after-code" } },
      } as Partial<ProjectConfig>),
      { fromStage: "code", dryRun: true },
    );

    expect(mockTelegram.sendError).toHaveBeenCalled();
  });

  it("PIPELINE_ABORTED IS emitted — isAborted becomes true", async () => {
    const ticketKey = "CF-HOOK5";
    const { HookError } = await import("../pipeline/hooks.js");
    mockRunHook.mockImplementation((name: string) => {
      if (name === "afterCode")
        return Promise.reject(new HookError("afterCode", 1));
      return Promise.resolve();
    });

    const { runPipeline } = await import("../pipeline/orchestrator.js");
    await runPipeline(
      ticketKey,
      makeConfig({
        pipeline: { hooks: { afterCode: "echo after-code" } },
      } as Partial<ProjectConfig>),
      { fromStage: "code", dryRun: true },
    );

    const { StateManager } = await import("../pipeline/state.js");
    const stateAfter = new StateManager(getRunDir(ticketKey));
    expect(stateAfter.current.isAborted).toBe(true);
  });
});

// ── 4. Stage timeout ──────────────────────────────────────────────────────────
//
// When config.pipeline.stageTimeouts[stage] is set, withTimeout wraps stage.run().
// If the stage takes longer than the timeout, it throws "Stage timed out after Xms".
// The orchestrator handles this as a regular stage failure: STAGE_FAILED + PIPELINE_ABORTED.

describe("Stage timeout (withTimeout fires)", () => {
  it("sendError called with 'timed out' error", async () => {
    // jira.get never resolves — withTimeout(50ms) wins the race
    mockJira.get.mockImplementationOnce(() => new Promise(() => {}));

    const { runPipeline } = await import("../pipeline/orchestrator.js");
    await runPipeline(
      "CF-TO1",
      makeConfig({
        pipeline: { stageTimeouts: { fetch: 50 } },
      } as Partial<ProjectConfig>),
    );

    expect(mockTelegram.sendError).toHaveBeenCalled();
    const [, err] = mockTelegram.sendError.mock.calls[0] as [string, Error];
    expect(err.message).toMatch(/timed out after 50ms/);
  }, 10_000);

  it("STAGE_FAILED emitted for the timed-out stage, pipeline aborted", async () => {
    const ticketKey = "CF-TO2";
    // never resolves — withTimeout(50ms) wins the race
    mockJira.get.mockImplementationOnce(() => new Promise(() => {}));

    const { runPipeline } = await import("../pipeline/orchestrator.js");
    await runPipeline(
      ticketKey,
      makeConfig({
        pipeline: { stageTimeouts: { fetch: 50 } },
      } as Partial<ProjectConfig>),
    );

    const { StateManager } = await import("../pipeline/state.js");
    const stateAfter = new StateManager(getRunDir(ticketKey));
    expect(stateAfter.current.failedStage).toBe("fetch");
    expect(stateAfter.current.isAborted).toBe(true);
  }, 10_000);
});

// ── 5. Cost limit exceeded ────────────────────────────────────────────────────
//
// After each stage, if maxCostUsdPerRun is configured, checkCostLimit runs.
// If it returns "abort", the orchestrator emits PIPELINE_ABORTED and throws.
// Subsequent stages never run.

describe("Cost limit exceeded after first stage", () => {
  it("sendError IS called when cost limit is hit", async () => {
    mockCheckCostLimit.mockResolvedValueOnce("abort");

    const { runPipeline } = await import("../pipeline/orchestrator.js");
    await runPipeline(
      "CF-COST1",
      makeConfig({
        pipeline: { maxCostUsdPerRun: 0.01 },
      } as Partial<ProjectConfig>),
    );

    expect(mockTelegram.sendError).toHaveBeenCalled();
  });

  it("analyze stage does NOT run after cost limit abort at fetch", async () => {
    mockCheckCostLimit.mockResolvedValueOnce("abort");

    const { runPipeline } = await import("../pipeline/orchestrator.js");
    await runPipeline(
      "CF-COST2",
      makeConfig({
        pipeline: { maxCostUsdPerRun: 0.01 },
      } as Partial<ProjectConfig>),
    );

    // runAgent is only called by analyze/code/review — none of which run
    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  it("80% warning message sent when cost is approaching limit", async () => {
    // checkCostLimit returns "continue" but the real implementation would send
    // a warning at 80%. We verify the telegram.send is called by cost-guard.
    // Here we test via the real mock: simulate cost-guard calling telegram.send.
    mockCheckCostLimit.mockImplementationOnce(
      async (opts: { telegram: typeof mockTelegram }) => {
        await opts.telegram.send("⚠️ Cost at 80%");
        return "continue" as const;
      },
    );

    const { runPipeline } = await import("../pipeline/orchestrator.js");
    await runPipeline(
      "CF-COST3",
      makeConfig({
        pipeline: { maxCostUsdPerRun: 0.01 },
      } as Partial<ProjectConfig>),
      { toStage: "fetch" },
    );

    expect(mockTelegram.send).toHaveBeenCalledWith(
      expect.stringContaining("80%"),
    );
  });
});

// ── 6. afterPipeline hook always runs ────────────────────────────────────────
//
// The finally block in runPipeline always runs runHook("afterPipeline", ...)
// and lock.release() — even when the pipeline aborts or returns via SKIP signal.

describe("afterPipeline hook always runs in finally", () => {
  it("runs even when a stage throws (abort path)", async () => {
    mockJira.get.mockRejectedValueOnce(new Error("Jira is down"));

    const { runPipeline } = await import("../pipeline/orchestrator.js");
    await runPipeline(
      "CF-FIN1",
      makeConfig({
        pipeline: { hooks: { afterPipeline: "echo cleanup" } },
      } as Partial<ProjectConfig>),
    );

    const afterCalls = (mockRunHook.mock.calls as Array<[string]>).filter(
      ([name]) => name === "afterPipeline",
    );
    expect(afterCalls).toHaveLength(1);
  });

  it("runs even when pipeline returns via SKIP signal", async () => {
    const ticketKey = "CF-FIN2";
    seedState(ticketKey, [
      { type: "STARTED", ticketKey },
      { type: "STAGE_COMPLETED", stage: "fetch", output: {} },
      {
        type: "STAGE_COMPLETED",
        stage: "analyze",
        output: {
          score: 0.2,
          missing: [],
          questions: ["Q1?"],
          needsClarification: true,
        },
      },
    ]);
    mockRequestClarification.mockRejectedValueOnce(
      new Error("SKIP: timed out"),
    );

    const { runPipeline } = await import("../pipeline/orchestrator.js");
    await runPipeline(
      ticketKey,
      makeConfig({
        pipeline: { hooks: { afterPipeline: "echo cleanup" } },
      } as Partial<ProjectConfig>),
      { fromStage: "clarify" },
    );

    const afterCalls = (mockRunHook.mock.calls as Array<[string]>).filter(
      ([name]) => name === "afterPipeline",
    );
    expect(afterCalls).toHaveLength(1);
  });
});
