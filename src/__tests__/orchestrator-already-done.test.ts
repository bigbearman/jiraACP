/**
 * Test cases: what happens when a ticket has already been fixed / pipeline already ran?
 *
 * Scenarios:
 * 1. resumePipeline — pipeline already completed (isCompleted = true)
 * 2. runPipeline    — lock already held (another instance running)
 * 3. Jira ticket    — already in "Done" status when fetched
 * 4. Git stage      — branch already exists on remote (push fails)
 * 5. Git stage      — PR already open (createPR returns existing PR number)
 * 6. Review stage   — PR already merged (mergePR throws "already merged")
 * 7. resumePipeline — failed stage → resumes from that stage (not from scratch)
 * 8. resumePipeline — currentStage set → resumes from that stage
 * 9. filterStages   — fromStage not found → starts from beginning
 * 10. filterStages  — toStage not found → runs to end
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProjectConfig } from "../config/schema.js";

// ── mocks ────────────────────────────────────────────────────────────────────

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
  runAgent: vi
    .fn()
    .mockResolvedValue('{"score":0.9,"missing":[],"questions":[]}'),
  runAgentsParallel: vi
    .fn()
    .mockResolvedValue(['{"issues":[]}', '{"issues":[]}']),
  detectComplexity: vi.fn().mockReturnValue("sonnet"),
}));
vi.mock("../utils/process.js", () => ({
  spawnSafe: vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 }),
  buildMinimalEnv: vi.fn().mockReturnValue({}),
}));

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
  getCheckRuns: vi.fn().mockResolvedValue([]),
  getCheckRunLog: vi.fn().mockResolvedValue(""),
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

// ── helpers ───────────────────────────────────────────────────────────────────

let tmpHome: string;

function makeConfig(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    name: "test-project",
    jira: {
      instance: "test",
      url: "https://test.atlassian.net",
      email: "dev@test.com",
      token: "jira-token",
      projectKey: "TEST",
      assignees: ["acc-1"],
      acceptanceCriteriaField: "customfield_10014",
    },
    github: {
      owner: "testorg",
      repo: "test-repo",
      token: "ghp-token",
      defaultBranch: "main",
      ciNoChecksGraceMs: 0,
    },
    workspace: { rootDir: tmpHome },
    telegram: { botToken: "123:ABC", chatId: "-100123" },
    ...overrides,
  } as ProjectConfig;
}

function makeFetchResponse(status = "In Progress") {
  return {
    data: {
      fields: {
        summary: "Fix login redirect",
        status: { name: status },
        assignee: { displayName: "Dev" },
        priority: { name: "Medium" },
        description: null,
        customfield_10014: null,
      },
    },
  };
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "orch-done-test-"));
  vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
  vi.clearAllMocks();
  // Default: jira GET returns in-progress ticket
  mockJira.get.mockResolvedValue(makeFetchResponse("In Progress"));
  mockJira.post.mockResolvedValue({
    data: { transitions: [] },
  });
  mockGithub.createPR.mockResolvedValue(42);
  mockGithub.mergePR.mockResolvedValue(undefined);
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  vi.resetModules();
});

// ── 1. resumePipeline — already completed ─────────────────────────────────────

describe("resumePipeline — already completed", () => {
  it("returns early without re-running any stage", async () => {
    const { resumePipeline } = await import("../pipeline/orchestrator.js");
    const { StateManager, getRunDir } = await import("../pipeline/state.js");

    const config = makeConfig();
    const runDir = getRunDir(config.name, "TEST-1");
    fs.mkdirSync(runDir, { recursive: true });

    // Write a completed state
    const state = new StateManager(runDir);
    state.emit({ type: "STARTED", ticketKey: "TEST-1" });
    state.emit({ type: "STAGE_COMPLETED", stage: "fetch", output: {} });
    state.emit({ type: "PIPELINE_COMPLETED" });

    const writeSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    await resumePipeline("TEST-1", config);

    // Jira should NOT have been called (no stage ran)
    expect(mockJira.get).not.toHaveBeenCalled();
    expect(writeSpy).toHaveBeenCalledWith(
      expect.stringContaining("already completed"),
    );
    writeSpy.mockRestore();
  });
});

// ── 2. runPipeline — lock already held ───────────────────────────────────────

describe("runPipeline — lock already held (another instance running)", () => {
  it("throws 'already running' and does not proceed", async () => {
    const { runPipeline } = await import("../pipeline/orchestrator.js");
    const { acquireLock } = await import("../utils/lock.js");
    const { getLockPath } = await import("../pipeline/state.js");

    const config = makeConfig();
    const lockPath = getLockPath(config.name, "TEST-2");
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });

    // Hold the lock before pipeline runs
    const lock = await acquireLock(lockPath);

    await expect(runPipeline("TEST-2", config)).rejects.toThrow(
      /already running/i,
    );

    // No Jira call should have been made
    expect(mockJira.get).not.toHaveBeenCalled();
    lock.release();
  });
});

// ── 3. Jira ticket already "Done" ────────────────────────────────────────────

describe("fetch stage — ticket already Done in Jira", () => {
  it("pipeline continues even when Jira status is Done (fetch does not block)", async () => {
    // Current behavior: fetch stage doesn't stop on Done status — it just records it.
    // This test documents the existing behavior. A future guard could be added to
    // skip the pipeline when the ticket is already Done.
    const { runPipeline } = await import("../pipeline/orchestrator.js");
    const config = makeConfig();

    mockJira.get.mockImplementation((url: string) => {
      if (url.includes("/transitions"))
        return Promise.resolve({ data: { transitions: [] } });
      return Promise.resolve(makeFetchResponse("Done"));
    });

    // Pipeline runs through (analyze skips clarify, code runs in dryRun=false but no git push)
    await runPipeline("TEST-3", config, { dryRun: true });

    // Fetch was called — ticket data was retrieved including "Done" status
    expect(mockJira.get).toHaveBeenCalledWith(
      expect.stringContaining("/issue/TEST-3"),
      expect.anything(),
    );
  });
});

// ── 4. Git stage — branch already exists (idempotent) ────────────────────────

describe("git stage — branch already exists on remote (idempotent)", () => {
  it("skips push and completes git stage — does NOT abort pipeline", async () => {
    const { runPipeline } = await import("../pipeline/orchestrator.js");
    const { spawnSafe } = await import("../utils/process.js");
    const config = makeConfig();

    // git push rejected because branch already on remote
    vi.mocked(spawnSafe).mockResolvedValueOnce({
      stdout: "",
      stderr: "error: src refspec already exists",
      exitCode: 1,
    });

    const { StateManager, getRunDir } = await import("../pipeline/state.js");
    const runDir = getRunDir(config.name, "TEST-4");
    fs.mkdirSync(runDir, { recursive: true });
    const state = new StateManager(runDir);
    state.emit({ type: "STARTED", ticketKey: "TEST-4" });
    state.emit({
      type: "STAGE_COMPLETED",
      stage: "code",
      output: { branchName: "feature/TEST-4-fix-login" },
    });

    await runPipeline("TEST-4", config, { fromStage: "git", toStage: "git" });

    // Pipeline must NOT fail — push was skipped, createPR ran
    expect(mockTelegram.sendError).not.toHaveBeenCalled();
    expect(mockTelegram.notifyStageCompleted).toHaveBeenCalledWith("git");
    expect(mockGithub.createPR).toHaveBeenCalled();
  });
});

// ── 5. Git stage — PR already open (idempotent) ───────────────────────────────

describe("git stage — PR already open for this branch (idempotent)", () => {
  it("recovers existing PR via findOpenPR and completes git stage", async () => {
    const { runPipeline } = await import("../pipeline/orchestrator.js");
    const config = makeConfig();

    mockGithub.createPR.mockRejectedValueOnce(
      new Error(
        "Validation Failed: A pull request already exists for this branch",
      ),
    );
    // findOpenPR finds the already-open PR
    mockGithub.findOpenPR.mockResolvedValueOnce(77);

    const { StateManager, getRunDir } = await import("../pipeline/state.js");
    const runDir = getRunDir(config.name, "TEST-5");
    fs.mkdirSync(runDir, { recursive: true });
    const state = new StateManager(runDir);
    state.emit({ type: "STARTED", ticketKey: "TEST-5" });
    state.emit({
      type: "STAGE_COMPLETED",
      stage: "code",
      output: { branchName: "feature/TEST-5-fix" },
    });

    await runPipeline("TEST-5", config, { fromStage: "git", toStage: "git" });

    // Pipeline must NOT fail — existing PR was reused
    expect(mockTelegram.sendError).not.toHaveBeenCalled();
    expect(mockTelegram.notifyStageCompleted).toHaveBeenCalledWith("git");
  });
});

// ── 6. Review stage — PR already merged ──────────────────────────────────────

describe("review stage — PR already merged", () => {
  it("pipeline fails when mergePR throws 'already merged'", async () => {
    const { runPipeline } = await import("../pipeline/orchestrator.js");
    const config = makeConfig();

    mockGithub.mergePR.mockRejectedValueOnce(
      new Error("Pull Request is not mergeable: already merged"),
    );

    const { StateManager, getRunDir } = await import("../pipeline/state.js");
    const runDir = getRunDir(config.name, "TEST-6");
    fs.mkdirSync(runDir, { recursive: true });
    const state = new StateManager(runDir);
    state.emit({ type: "STARTED", ticketKey: "TEST-6" });
    state.emit({
      type: "STAGE_COMPLETED",
      stage: "git",
      output: { branchName: "feature/TEST-6", prNumber: 99 },
    });

    mockJira.get.mockResolvedValue(makeFetchResponse());

    await runPipeline("TEST-6", config, { fromStage: "review" });

    expect(mockTelegram.sendError).toHaveBeenCalledWith(
      "TEST-6",
      expect.objectContaining({
        message: expect.stringContaining("already merged"),
      }),
    );
  });
});

// ── 7. resumePipeline — failed stage → resumes from failed stage ─────────────

describe("resumePipeline — failed stage", () => {
  it("resumes from the failed stage, not from fetch", async () => {
    const { resumePipeline } = await import("../pipeline/orchestrator.js");
    const { StateManager, getRunDir } = await import("../pipeline/state.js");
    const config = makeConfig();

    const runDir = getRunDir(config.name, "TEST-7");
    fs.mkdirSync(runDir, { recursive: true });
    const state = new StateManager(runDir);
    state.emit({ type: "STARTED", ticketKey: "TEST-7" });
    state.emit({ type: "STAGE_COMPLETED", stage: "fetch", output: {} });
    state.emit({
      type: "STAGE_COMPLETED",
      stage: "analyze",
      output: { score: 0.9, needsClarification: false },
    });
    state.emit({ type: "STAGE_FAILED", stage: "code", error: "timeout" });

    mockJira.get.mockImplementation((url: string) => {
      if (url.includes("/transitions"))
        return Promise.resolve({ data: { transitions: [] } });
      return Promise.resolve(makeFetchResponse());
    });

    await resumePipeline("TEST-7", config);

    // fetch should NOT be called (resumed from code stage, not fetch)
    const jiraCalls = mockJira.get.mock.calls.map((c) => c[0] as string);
    const fetchCalled = jiraCalls.some(
      (u) => u.includes("/issue/TEST-7") && !u.includes("/transitions"),
    );
    expect(fetchCalled).toBe(false);
  });
});

// ── 8. resumePipeline — currentStage set (was mid-run) ───────────────────────

describe("resumePipeline — currentStage set (interrupted mid-run)", () => {
  it("resumes from currentStage when set", async () => {
    const { resumePipeline } = await import("../pipeline/orchestrator.js");
    const { StateManager, getRunDir } = await import("../pipeline/state.js");
    const config = makeConfig();

    const runDir = getRunDir(config.name, "TEST-8");
    fs.mkdirSync(runDir, { recursive: true });
    const state = new StateManager(runDir);
    state.emit({ type: "STARTED", ticketKey: "TEST-8" });
    state.emit({ type: "STAGE_COMPLETED", stage: "fetch", output: {} });
    state.emit({ type: "STAGE_STARTED", stage: "analyze" });
    // Interrupted here — currentStage = "analyze", no STAGE_FAILED

    expect(state.current.currentStage).toBe("analyze");
    expect(state.current.failedStage).toBeNull();

    mockJira.get.mockImplementation((url: string) => {
      if (url.includes("/transitions"))
        return Promise.resolve({ data: { transitions: [] } });
      return Promise.resolve(makeFetchResponse());
    });

    await resumePipeline("TEST-8", config);

    // fetch should NOT have been called
    const jiraCalls = mockJira.get.mock.calls.map((c) => c[0] as string);
    const fetchCalled = jiraCalls.some(
      (u) => u.includes("/issue/TEST-8") && !u.includes("/transitions"),
    );
    expect(fetchCalled).toBe(false);
  });
});

// ── 11–13. Fresh run, code already fixed (no prior pipeline state) ───────────
/**
 * These tests simulate the common "developer already fixed it manually" case:
 * - No pipeline state file exists (pipeline never ran for this ticket)
 * - Jira ticket is still "In Progress"
 * - But code, branch, or PR already exists on the remote
 */

describe("fresh run — branch already pushed manually (no prior state, idempotent)", () => {
  it("skips push, creates PR, completes git stage — does NOT abort pipeline", async () => {
    const { runPipeline } = await import("../pipeline/orchestrator.js");
    const { spawnSafe } = await import("../utils/process.js");
    const config = makeConfig();

    // Branch already exists on remote → push rejected
    vi.mocked(spawnSafe).mockResolvedValueOnce({
      stdout: "",
      stderr: "error: failed to push some refs — branch already exists",
      exitCode: 1,
    });

    await runPipeline("TEST-11", config, { toStage: "git" });

    expect(mockTelegram.sendError).not.toHaveBeenCalled();
    expect(mockTelegram.notifyStageCompleted).toHaveBeenCalledWith("git");
    expect(mockGithub.createPR).toHaveBeenCalled();
  });
});

describe("fresh run — PR already open (no prior state, idempotent)", () => {
  it("recovers existing PR via findOpenPR, completes git stage — does NOT abort pipeline", async () => {
    const { runPipeline } = await import("../pipeline/orchestrator.js");
    const config = makeConfig();

    mockGithub.createPR.mockRejectedValueOnce(
      new Error(
        "Validation Failed: A pull request already exists for this branch",
      ),
    );
    // findOpenPR locates the existing open PR
    mockGithub.findOpenPR.mockResolvedValueOnce(88);

    await runPipeline("TEST-12", config, { toStage: "git" });

    expect(mockTelegram.sendError).not.toHaveBeenCalled();
    expect(mockTelegram.notifyStageCompleted).toHaveBeenCalledWith("git");
  });
});

describe("fresh run — code merged, Jira still In Progress (notify stage fails)", () => {
  it("fails at notify stage when Jira rejects the Done transition", async () => {
    // Scenario: developer fixed the code, PR merged, but forgot to close the Jira ticket.
    // Pipeline is triggered manually. All stages up to notify complete. Jira API rejects
    // the transition because the ticket is in a state that doesn't allow "Done".
    const { runPipeline } = await import("../pipeline/orchestrator.js");
    const config = makeConfig();

    mockJira.get.mockImplementation((url: string) => {
      if (url.includes("/transitions"))
        return Promise.resolve({
          data: { transitions: [{ id: "31", name: "Done" }] },
        });
      return Promise.resolve(makeFetchResponse("In Progress"));
    });

    // Jira rejects transition (e.g. ticket is already Done in the background)
    mockJira.post.mockRejectedValueOnce(
      new Error("400 Bad Request: Transition not allowed for current status"),
    );

    await runPipeline("TEST-13", config, { fromStage: "notify" });

    expect(mockTelegram.sendError).toHaveBeenCalledWith(
      "TEST-13",
      expect.objectContaining({
        message: expect.stringContaining("Transition not allowed"),
      }),
    );
  });
});

// ── 9 & 10. filterStages edge cases ──────────────────────────────────────────

describe("filterStages — edge cases", () => {
  it("starts from beginning when fromStage is not found in stage list", async () => {
    const { runPipeline } = await import("../pipeline/orchestrator.js");
    const config = makeConfig();

    mockJira.get.mockImplementation((url: string) => {
      if (url.includes("/transitions"))
        return Promise.resolve({ data: { transitions: [] } });
      return Promise.resolve(makeFetchResponse());
    });

    // "invalid-stage" does not exist → fromIdx = -1 → starts from 0 (fetch)
    await runPipeline("TEST-9", config, {
      fromStage: "invalid-stage" as never,
      dryRun: true,
    });

    // fetch ran → jira.get was called for the ticket
    expect(mockJira.get).toHaveBeenCalledWith(
      expect.stringContaining("/issue/TEST-9"),
      expect.anything(),
    );
  });

  it("runs to end when toStage is not found in stage list", async () => {
    const { runPipeline } = await import("../pipeline/orchestrator.js");
    const config = makeConfig();

    mockJira.get.mockImplementation((url: string) => {
      if (url.includes("/transitions"))
        return Promise.resolve({ data: { transitions: [] } });
      return Promise.resolve(makeFetchResponse());
    });

    // toStage not found → toIdx = -1 → runs all stages to end
    await runPipeline("TEST-10", config, {
      toStage: "invalid-stage" as never,
      dryRun: true,
    });

    // git stage ran — proves pipeline ran past early stages (toStage filtering was ignored)
    // dryRun mode: prNumber=null causes review to abort, but git still ran
    expect(mockTelegram.notifyStageStarted).toHaveBeenCalledWith("git");
  });
});
