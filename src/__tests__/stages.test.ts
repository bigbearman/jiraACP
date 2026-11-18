/**
 * Tests for pipeline stages 2–8.
 * runAgent / runAgentsParallel are mocked so no real AI calls are made.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PipelineContext } from "../pipeline/stages/types.js";
import type { TelegramNotifier } from "../integrations/telegram/notifier.js";
import type { Logger } from "pino";

// ── Mocks ─────────────────────────────────────────────────────────────────────
vi.mock("../pipeline/runner.js", () => ({
  runAgent: vi.fn(),
  runAgentsParallel: vi
    .fn()
    .mockResolvedValue(['{"issues":[]}', '{"issues":[]}']),
  detectComplexity: vi.fn(() => "sonnet" as const),
}));

vi.mock("../utils/process.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/process.js")>();
  return {
    ...actual,
    spawnSafe: vi
      .fn()
      .mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 }),
  };
});

vi.mock("../integrations/telegram/human-loop.js", () => ({
  requestClarification: vi.fn().mockResolvedValue("Clarification answer"),
  requestApproval: vi.fn().mockResolvedValue(true),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jira-stages-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.resetModules();
  vi.clearAllMocks();
});

function makeCtx(overrides: Partial<PipelineContext> = {}): PipelineContext {
  const memoryDir = path.join(tmpDir, "memory");
  return {
    ticketKey: "HI-200",
    projectDir: tmpDir,
    memoryDir,
    dryRun: false,
    config: {
      name: "test",
      jira: {
        instance: "hi",
        url: "https://test.atlassian.net",
        email: "dev@test.com",
        token: "token",
        projectKey: "HI",
        assignees: [],
        acceptanceCriteriaField: "customfield_10016",
        inProgressTransition: "In Progress",
        inReviewTransition: "In Review",
        doneTransition: "Done",
        clarityScoreThreshold: 0.7,
        requiredFields: ["description"],
      },
      github: {
        owner: "org",
        repo: "repo",
        token: "ghp",
        defaultBranch: "main",
        branchPattern: "feature/{ticketKey}-{slug}",
        branchPrefix: "feature",
        autoMergeStrategy: "squash",
        reviewers: [],
        prDraftByDefault: false,
        majorIssueThreshold: 1,
        ciNoChecksGraceMs: 0,
      },
      workspace: { rootDir: tmpDir, allowedPaths: [] },
      deploy: {
        enabled: false,
        timeoutMs: 1_200_000,
        healthCheckTimeoutMs: 30_000,
        env: {},
      },
      test: {
        enabled: false,
        retries: 0,
        waitBeforeTestMs: 0,
        timeoutMs: 300_000,
        specPattern: "e2e/**/*.spec.ts",
      },
      telegram: {
        botToken: "123:ABC",
        chatId: "-100",
        notifyOnStages: [],
        humanInTheLoop: {
          clarificationTimeoutMs: 3_600_000,
          clarificationTimeoutAction: "skip",
          reviewApprovalTimeoutMs: 86_400_000,
          reviewApprovalTimeoutAction: "abort",
        },
      },
      pipeline: {
        maxConcurrentRuns: 2,
        stageTimeouts: {
          fetch: 30_000,
          analyze: 60_000,
          clarify: 3_600_000,
          code: 1_800_000,
          git: 60_000,
          review: 600_000,
          deploy: 1_200_000,
          test: 300_000,
          notify: 30_000,
        },
        agentStallTimeoutMs: 300_000,
        skipClarificationIfClear: true,
        failOnTestFailure: false,
        failOnDeployFailure: true,
        hooks: {},
      },
    },
    jira: {
      get: vi.fn(),
      post: vi.fn(),
      put: vi.fn(),
    } as unknown as PipelineContext["jira"],
    github: {
      createPR: vi.fn().mockResolvedValue(42),
      addReviewers: vi.fn().mockResolvedValue(undefined),
      mergePR: vi.fn().mockResolvedValue(undefined),
      getCheckRuns: vi.fn().mockResolvedValue([]),
      getCheckRunLog: vi.fn().mockResolvedValue(""),
    } as unknown as PipelineContext["github"],
    telegram: {
      send: vi.fn(),
      sendError: vi.fn(),
      sendDone: vi.fn(),
      notifyStageStarted: vi.fn(),
      notifyStageCompleted: vi.fn(),
      notifyStageFailed: vi.fn(),
      notifyStageSkipped: vi.fn(),
      updateDetail: vi.fn().mockResolvedValue(undefined),
    } as TelegramNotifier,
    state: {
      emit: vi.fn(),
      // Tests seed `events`; mirror StateManager.lastStageOutput over them
      lastStageOutput(
        this: { events?: Array<{ stage?: string; output?: unknown }> },
        stage: string,
      ): unknown {
        return this.events?.filter((e) => e.stage === stage).at(-1)?.output;
      },
      current: {
        ticketKey: "HI-200",
        currentStage: null,
        completedStages: [],
        failedStage: null,
        pendingClarification: false,
        pendingHumanApproval: false,
        branchName: null,
        prNumber: null,
        isCompleted: false,
        isAborted: false,
        abortReason: null,
        startedAt: null,
      },
    } as unknown as PipelineContext["state"],
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as Logger,
    ...overrides,
  };
}

function writeTicketCtx(
  memoryDir: string,
  content = "## Summary\nTest ticket",
): void {
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.writeFileSync(path.join(memoryDir, "ticket-context.md"), content);
}

// ── analyzeStage ─────────────────────────────────────────────────────────────

describe("analyzeStage", () => {
  it("throws if ticket-context.md is missing", async () => {
    const { analyzeStage } = await import("../pipeline/stages/2-analyze.js");
    const ctx = makeCtx();
    await expect(analyzeStage.run(ctx)).rejects.toThrow(
      "ticket-context.md not found",
    );
  });

  it("returns needsClarification: false when score >= threshold", async () => {
    const { runAgent } = await import("../pipeline/runner.js");
    (runAgent as ReturnType<typeof vi.fn>).mockResolvedValue(
      '{"score":0.9,"missing":[],"questions":[]}',
    );
    const { analyzeStage } = await import("../pipeline/stages/2-analyze.js");
    const ctx = makeCtx();
    writeTicketCtx(ctx.memoryDir);

    const out = await analyzeStage.run(ctx);
    expect(out.needsClarification).toBe(false);
    expect(out.score).toBe(0.9);
  });

  it("returns needsClarification: true when score < threshold", async () => {
    const { runAgent } = await import("../pipeline/runner.js");
    (runAgent as ReturnType<typeof vi.fn>).mockResolvedValue(
      '{"score":0.4,"missing":["AC"],"questions":["What is the goal?"]}',
    );
    const { analyzeStage } = await import("../pipeline/stages/2-analyze.js");
    const ctx = makeCtx();
    writeTicketCtx(ctx.memoryDir);

    const out = await analyzeStage.run(ctx);
    expect(out.needsClarification).toBe(true);
    expect(out.missing).toContain("AC");
  });

  it("defaults to needsClarification: true when JSON parse fails", async () => {
    const { runAgent } = await import("../pipeline/runner.js");
    (runAgent as ReturnType<typeof vi.fn>).mockResolvedValue("not json at all");
    const { analyzeStage } = await import("../pipeline/stages/2-analyze.js");
    const ctx = makeCtx();
    writeTicketCtx(ctx.memoryDir);

    const out = await analyzeStage.run(ctx);
    expect(out.needsClarification).toBe(true);
    expect(out.score).toBe(0.5);
  });
});

// ── clarifyStage ──────────────────────────────────────────────────────────────

describe("clarifyStage.shouldSkip", () => {
  it("returns true when analyze stage not completed", async () => {
    const { clarifyStage } = await import("../pipeline/stages/3-clarify.js");
    const ctx = makeCtx();
    expect(await clarifyStage.shouldSkip!(ctx)).toBe(true);
  });

  it("returns true when analyze output says needsClarification: false", async () => {
    const { clarifyStage } = await import("../pipeline/stages/3-clarify.js");
    const ctx = makeCtx();
    (ctx.state.current.completedStages as string[]).push("analyze");
    (ctx.state as unknown as { events: unknown[] }).events = [
      {
        type: "STAGE_COMPLETED",
        stage: "analyze",
        output: { needsClarification: false },
      },
    ];
    expect(await clarifyStage.shouldSkip!(ctx)).toBe(true);
  });

  it("returns false when needsClarification is true", async () => {
    const { clarifyStage } = await import("../pipeline/stages/3-clarify.js");
    const ctx = makeCtx();
    (ctx.state.current.completedStages as string[]).push("analyze");
    (ctx.state as unknown as { events: unknown[] }).events = [
      {
        type: "STAGE_COMPLETED",
        stage: "analyze",
        output: { needsClarification: true },
      },
    ];
    expect(await clarifyStage.shouldSkip!(ctx)).toBe(false);
  });
});

// ── codeStage ────────────────────────────────────────────────────────────────

describe("codeStage", () => {
  it("returns branchName in dryRun without calling runAgent", async () => {
    const { runAgent } = await import("../pipeline/runner.js");
    const { codeStage } = await import("../pipeline/stages/4-code.js");
    const ctx = makeCtx({ dryRun: true });
    writeTicketCtx(ctx.memoryDir, "## Summary\nAdd login page");

    const out = await codeStage.run(ctx);
    expect(typeof out.branchName).toBe("string");
    expect(out.branchName).toContain("HI-200");
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("builds branch name from ticket summary", async () => {
    const { codeStage } = await import("../pipeline/stages/4-code.js");
    const ctx = makeCtx({ dryRun: true });
    writeTicketCtx(ctx.memoryDir, "## Summary\nAdd login page with OAuth");

    const out = await codeStage.run(ctx);
    expect(out.branchName).toContain("add-login-page");
  });

  it("calls runAgent in non-dryRun mode", async () => {
    const { runAgent } = await import("../pipeline/runner.js");
    (runAgent as ReturnType<typeof vi.fn>).mockResolvedValueOnce("done");
    const { codeStage } = await import("../pipeline/stages/4-code.js");
    const ctx = makeCtx({ dryRun: false });
    writeTicketCtx(ctx.memoryDir, "## Summary\nFix critical bug");

    await codeStage.run(ctx);
    expect(runAgent).toHaveBeenCalledOnce();
  });
});

// ── gitStage ──────────────────────────────────────────────────────────────────

describe("gitStage", () => {
  it("throws if branchName is null in state", async () => {
    const { gitStage } = await import("../pipeline/stages/5-git.js");
    const ctx = makeCtx();
    writeTicketCtx(ctx.memoryDir);

    await expect(gitStage.run(ctx)).rejects.toThrow("No branch name in state");
  });

  it("returns { branchName, prNumber: null } in dryRun", async () => {
    const { gitStage } = await import("../pipeline/stages/5-git.js");
    const ctx = makeCtx({ dryRun: true });
    ctx.state.current.branchName = "feature/HI-200-test";
    writeTicketCtx(ctx.memoryDir);

    const out = await gitStage.run(ctx);
    expect(out.branchName).toBe("feature/HI-200-test");
    expect(out.prNumber).toBeNull();
  });

  it("creates PR and returns prNumber in non-dryRun", async () => {
    const { gitStage } = await import("../pipeline/stages/5-git.js");
    const ctx = makeCtx({ dryRun: false });
    ctx.state.current.branchName = "feature/HI-200-impl";
    writeTicketCtx(ctx.memoryDir, "## Summary\nImplement feature");

    const out = await gitStage.run(ctx);
    expect(out.prNumber).toBe(42); // mocked createPR returns 42
    expect(ctx.github.createPR).toHaveBeenCalledOnce();
  });

  it("adds reviewers when config.github.reviewers is non-empty", async () => {
    const { gitStage } = await import("../pipeline/stages/5-git.js");
    const ctx = makeCtx({ dryRun: false });
    ctx.state.current.branchName = "feature/HI-200-reviewers";
    ctx.config.github.reviewers = ["reviewer-a", "reviewer-b"];
    writeTicketCtx(ctx.memoryDir, "## Summary\nAdd feature");

    await gitStage.run(ctx);
    expect(ctx.github.addReviewers).toHaveBeenCalledWith(42, [
      "reviewer-a",
      "reviewer-b",
    ]);
  });
});

// ── reviewStage ───────────────────────────────────────────────────────────────

describe("reviewStage", () => {
  it("throws if prNumber is null in state", async () => {
    const { reviewStage } = await import("../pipeline/stages/6-review.js");
    const ctx = makeCtx();
    await expect(reviewStage.run(ctx)).rejects.toThrow("No PR number in state");
  });

  it("does not merge in dryRun when no major issues", async () => {
    const { reviewStage } = await import("../pipeline/stages/6-review.js");
    const ctx = makeCtx({ dryRun: true });
    ctx.state.current.prNumber = 7;
    fs.mkdirSync(ctx.memoryDir, { recursive: true });

    const out = await reviewStage.run(ctx);
    expect(out.merged).toBe(false);
    expect(ctx.github.mergePR).not.toHaveBeenCalled();
    expect(Array.isArray(out.issues)).toBe(true);
  });
});

// ── deployStage ───────────────────────────────────────────────────────────────

describe("deployStage", () => {
  it("shouldSkip returns true when deploy.enabled is false", async () => {
    const { deployStage } = await import("../pipeline/stages/7-deploy.js");
    const ctx = makeCtx();
    expect(await deployStage.shouldSkip!(ctx)).toBe(true);
  });

  it("shouldSkip returns false when deploy.enabled is true", async () => {
    const { deployStage } = await import("../pipeline/stages/7-deploy.js");
    const ctx = makeCtx();
    ctx.config.deploy.enabled = true;
    expect(await deployStage.shouldSkip!(ctx)).toBe(false);
  });

  it("returns { deployed: false, dryRun: true } in dryRun", async () => {
    const { deployStage } = await import("../pipeline/stages/7-deploy.js");
    const ctx = makeCtx({ dryRun: true });
    ctx.config.deploy.enabled = true;
    (ctx.config.deploy as Record<string, unknown>).command = "echo deploy";

    const out = await deployStage.run(ctx);
    expect(out.deployed).toBe(false);
    expect(out.dryRun).toBe(true);
  });

  it("throws if deploy.command is not configured", async () => {
    const { deployStage } = await import("../pipeline/stages/7-deploy.js");
    const ctx = makeCtx();
    ctx.config.deploy.enabled = true;

    await expect(deployStage.run(ctx)).rejects.toThrow(
      "deploy.command not configured",
    );
  });

  it("runs deploy command and returns { deployed: true } on success", async () => {
    const { deployStage } = await import("../pipeline/stages/7-deploy.js");
    const ctx = makeCtx({ dryRun: false });
    ctx.config.deploy.enabled = true;
    (ctx.config.deploy as Record<string, unknown>).command = "echo";

    const out = await deployStage.run(ctx);
    expect(out.deployed).toBe(true);
  });

  it("throws when deploy command exits non-zero", async () => {
    const { spawnSafe } = await import("../utils/process.js");
    (spawnSafe as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      stdout: "",
      stderr: "permission denied",
      exitCode: 1,
    });
    const { deployStage } = await import("../pipeline/stages/7-deploy.js");
    const ctx = makeCtx({ dryRun: false });
    ctx.config.deploy.enabled = true;
    (ctx.config.deploy as Record<string, unknown>).command = "false";

    await expect(deployStage.run(ctx)).rejects.toThrow("Deploy failed");
  });

  it("runs health check when healthCheckUrl is configured", async () => {
    // Mock global fetch to return ok response
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue({ ok: true } as Response);

    const { deployStage } = await import("../pipeline/stages/7-deploy.js");
    const ctx = makeCtx({ dryRun: false });
    ctx.config.deploy.enabled = true;
    (ctx.config.deploy as Record<string, unknown>).command = "echo";
    (ctx.config.deploy as Record<string, unknown>).healthCheckUrl =
      "http://localhost:3000/health";

    const out = await deployStage.run(ctx);
    expect(out.deployed).toBe(true);
    expect(fetchSpy).toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("throws when health check times out", async () => {
    // Mock fetch to always fail (non-ok), with a very short timeout
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue({ ok: false } as Response);

    const { deployStage } = await import("../pipeline/stages/7-deploy.js");
    const ctx = makeCtx({ dryRun: false });
    ctx.config.deploy.enabled = true;
    (ctx.config.deploy as Record<string, unknown>).command = "echo";
    (ctx.config.deploy as Record<string, unknown>).healthCheckUrl =
      "http://localhost:3000/health";
    ctx.config.deploy.healthCheckTimeoutMs = 50; // 50ms → times out quickly

    await expect(deployStage.run(ctx)).rejects.toThrow(
      /Health check timed out/,
    );
    fetchSpy.mockRestore();
  });
});

// ── testStage ─────────────────────────────────────────────────────────────────

describe("testStage", () => {
  it("shouldSkip returns true when test.enabled is false", async () => {
    const { testStage } = await import("../pipeline/stages/8-test.js");
    const ctx = makeCtx();
    expect(await testStage.shouldSkip!(ctx)).toBe(true);
  });

  it("shouldSkip returns false when test.enabled is true", async () => {
    const { testStage } = await import("../pipeline/stages/8-test.js");
    const ctx = makeCtx();
    ctx.config.test.enabled = true;
    expect(await testStage.shouldSkip!(ctx)).toBe(false);
  });

  it("throws if test.baseUrl is not configured", async () => {
    const { testStage } = await import("../pipeline/stages/8-test.js");
    const ctx = makeCtx();
    ctx.config.test.enabled = true;

    await expect(testStage.run(ctx)).rejects.toThrow(
      "test.baseUrl not configured",
    );
  });

  it("returns { passed: true } in dryRun", async () => {
    const { testStage } = await import("../pipeline/stages/8-test.js");
    const ctx = makeCtx({ dryRun: true });
    ctx.config.test.enabled = true;
    (ctx.config.test as Record<string, unknown>).baseUrl =
      "http://localhost:3000";

    const out = await testStage.run(ctx);
    expect(out.passed).toBe(true);
  });

  it("returns { passed: true } in non-dryRun with passing agent output", async () => {
    const { runAgent } = await import("../pipeline/runner.js");
    (runAgent as ReturnType<typeof vi.fn>).mockResolvedValue(
      '{"passed":true,"summary":"All tests passed","failures":[]}',
    );
    const { testStage } = await import("../pipeline/stages/8-test.js");
    const ctx = makeCtx({ dryRun: false });
    ctx.config.test.enabled = true;
    (ctx.config.test as Record<string, unknown>).baseUrl =
      "http://localhost:3000";
    ctx.config.test.waitBeforeTestMs = 0;

    const out = await testStage.run(ctx);
    expect(out.passed).toBe(true);
  });
});

// ── clarifyStage.run ──────────────────────────────────────────────────────────

describe("clarifyStage.run", () => {
  it("calls requestClarification and appends answers to memory", async () => {
    const { clarifyStage } = await import("../pipeline/stages/3-clarify.js");
    const ctx = makeCtx();
    writeTicketCtx(ctx.memoryDir);
    (ctx.state as unknown as { events: unknown[] }).events = [
      {
        type: "STAGE_COMPLETED",
        stage: "analyze",
        output: {
          needsClarification: true,
          questions: ["What auth method?"],
        },
      },
    ];

    const out = await clarifyStage.run(ctx);
    expect(out.clarified).toBe(true);
    expect(typeof out.answers).toBe("string");
  });
});

// ── reviewStage with agent responses ─────────────────────────────────────────

describe("reviewStage with agent responses", () => {
  it("calls runAgentsParallel and collects issues", async () => {
    const { runAgentsParallel } = await import("../pipeline/runner.js");
    (runAgentsParallel as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      '{"issues":[{"severity":"minor","message":"Typo"}]}',
      '{"issues":[]}',
    ]);
    const { reviewStage } = await import("../pipeline/stages/6-review.js");
    const ctx = makeCtx({ dryRun: false });
    ctx.state.current.prNumber = 10;
    fs.mkdirSync(ctx.memoryDir, { recursive: true });

    const out = await reviewStage.run(ctx);
    expect(out.merged).toBe(true);
    expect(out.issues).toHaveLength(1);
    expect((out.issues as Array<{ severity: string }>)[0].severity).toBe(
      "minor",
    );
  });

  it("throws REVIEW_REJECTED when human rejects", async () => {
    const { requestApproval } =
      await import("../integrations/telegram/human-loop.js");
    const { runAgentsParallel } = await import("../pipeline/runner.js");
    // Return enough major issues to trigger human approval
    (runAgentsParallel as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      '{"issues":[{"severity":"major","message":"Critical bug"}]}',
      '{"issues":[]}',
    ]);
    (requestApproval as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);

    const { reviewStage } = await import("../pipeline/stages/6-review.js");
    const ctx = makeCtx({ dryRun: false });
    ctx.state.current.prNumber = 11;
    fs.mkdirSync(ctx.memoryDir, { recursive: true });

    await expect(reviewStage.run(ctx)).rejects.toThrow("REVIEW_REJECTED");
  });

  it("handles approved=true path with major issues", async () => {
    const { requestApproval } =
      await import("../integrations/telegram/human-loop.js");
    const { runAgentsParallel } = await import("../pipeline/runner.js");
    (runAgentsParallel as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      '{"issues":[{"severity":"major","message":"Big problem"}]}',
      '{"issues":[]}',
    ]);
    (requestApproval as ReturnType<typeof vi.fn>).mockResolvedValueOnce(true);

    const { reviewStage } = await import("../pipeline/stages/6-review.js");
    const ctx = makeCtx({ dryRun: false });
    ctx.state.current.prNumber = 12;
    fs.mkdirSync(ctx.memoryDir, { recursive: true });

    const out = await reviewStage.run(ctx);
    expect(out.merged).toBe(true);
    expect(ctx.state.emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: "HUMAN_APPROVED" }),
    );
  });

  it("returns empty issues when agent output JSON is unparseable", async () => {
    const { runAgentsParallel } = await import("../pipeline/runner.js");
    // Valid JSON regex match but invalid structure that throws during parse
    (runAgentsParallel as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      "no json here",
      "also no json",
    ]);

    const { reviewStage } = await import("../pipeline/stages/6-review.js");
    const ctx = makeCtx({ dryRun: false });
    ctx.state.current.prNumber = 13;
    fs.mkdirSync(ctx.memoryDir, { recursive: true });

    const out = await reviewStage.run(ctx);
    expect(Array.isArray(out.issues)).toBe(true);
    expect((out.issues as unknown[]).length).toBe(0);
  });
});

// ── testStage failure paths ───────────────────────────────────────────────────

describe("testStage failure and retry", () => {
  it("retries on failed test and then continues when failOnTest=false", async () => {
    const { runAgent } = await import("../pipeline/runner.js");
    (runAgent as ReturnType<typeof vi.fn>).mockResolvedValue(
      '{"passed":false,"summary":"fail","failures":["F1"]}',
    );
    const { testStage } = await import("../pipeline/stages/8-test.js");
    const ctx = makeCtx({ dryRun: false });
    ctx.config.test.enabled = true;
    ctx.config.test.retries = 1;
    ctx.config.test.waitBeforeTestMs = 0;
    ctx.config.pipeline!.failOnTestFailure = false;
    (ctx.config.test as Record<string, unknown>).baseUrl =
      "http://localhost:3000";

    const out = await testStage.run(ctx);
    expect(out.passed).toBe(false);
    expect(ctx.telegram.send).toHaveBeenCalled();
  });

  it("throws when failOnTest=true and tests fail", async () => {
    const { runAgent } = await import("../pipeline/runner.js");
    (runAgent as ReturnType<typeof vi.fn>).mockResolvedValue(
      '{"passed":false,"summary":"fail","failures":["Broken"]}',
    );
    const { testStage } = await import("../pipeline/stages/8-test.js");
    const ctx = makeCtx({ dryRun: false });
    ctx.config.test.enabled = true;
    ctx.config.test.retries = 0;
    ctx.config.test.waitBeforeTestMs = 0;
    ctx.config.pipeline!.failOnTestFailure = true;
    (ctx.config.test as Record<string, unknown>).baseUrl =
      "http://localhost:3000";

    await expect(testStage.run(ctx)).rejects.toThrow("Tests failed");
  });

  it("handles unparseable agent JSON in test stage", async () => {
    const { runAgent } = await import("../pipeline/runner.js");
    (runAgent as ReturnType<typeof vi.fn>).mockResolvedValue("not json");
    const { testStage } = await import("../pipeline/stages/8-test.js");
    const ctx = makeCtx({ dryRun: false });
    ctx.config.test.enabled = true;
    ctx.config.test.retries = 0;
    ctx.config.test.waitBeforeTestMs = 0;
    ctx.config.pipeline!.failOnTestFailure = false;
    (ctx.config.test as Record<string, unknown>).baseUrl =
      "http://localhost:3000";

    const out = await testStage.run(ctx);
    expect(out.passed).toBe(false);
  });
});

// ── analyzeStage ?? fallbacks ─────────────────────────────────────────────────

describe("analyzeStage ?? fallbacks", () => {
  it("uses default requiredFields and threshold when config omits them", async () => {
    const { runAgent } = await import("../pipeline/runner.js");
    (runAgent as ReturnType<typeof vi.fn>).mockResolvedValue(
      '{"score":0.9,"missing":[],"questions":[]}',
    );
    const { analyzeStage } = await import("../pipeline/stages/2-analyze.js");
    const ctx = makeCtx();
    (ctx.config.jira as Record<string, unknown>).requiredFields = undefined;
    (ctx.config.jira as Record<string, unknown>).clarityScoreThreshold =
      undefined;
    writeTicketCtx(ctx.memoryDir);
    const out = await analyzeStage.run(ctx);
    expect(out.needsClarification).toBe(false);
  });
});

// ── clarifyStage ?? fallbacks ─────────────────────────────────────────────────

describe("clarifyStage ?? fallbacks", () => {
  it("uses default questions when analyzeEvent has no questions field", async () => {
    const { clarifyStage } = await import("../pipeline/stages/3-clarify.js");
    const ctx = makeCtx();
    writeTicketCtx(ctx.memoryDir);
    (ctx.state as unknown as { events: unknown[] }).events = [
      {
        type: "STAGE_COMPLETED",
        stage: "analyze",
        output: { needsClarification: true }, // no questions field
      },
    ];
    const out = await clarifyStage.run(ctx);
    expect(out.clarified).toBe(true);
  });

  it("uses default timeouts when humanInTheLoop is undefined", async () => {
    const { clarifyStage } = await import("../pipeline/stages/3-clarify.js");
    const ctx = makeCtx();
    writeTicketCtx(ctx.memoryDir);
    (ctx.config.telegram as Record<string, unknown>).humanInTheLoop = undefined;
    (ctx.state as unknown as { events: unknown[] }).events = [
      {
        type: "STAGE_COMPLETED",
        stage: "analyze",
        output: { needsClarification: true, questions: ["Q?"] },
      },
    ];
    const out = await clarifyStage.run(ctx);
    expect(out.clarified).toBe(true);
  });
});

// ── codeStage ?? fallbacks ────────────────────────────────────────────────────

describe("codeStage ?? fallbacks", () => {
  it("uses default branchPattern when branchPattern is undefined", async () => {
    const { codeStage } = await import("../pipeline/stages/4-code.js");
    const ctx = makeCtx({ dryRun: true });
    (ctx.config.github as Record<string, unknown>).branchPattern = undefined;
    writeTicketCtx(ctx.memoryDir, "## Summary\nFix bug");
    const out = await codeStage.run(ctx);
    expect(out.branchName).toContain("HI-200");
  });

  it("includes buildCommand in prompt when workspace.buildCommand is set", async () => {
    const { codeStage } = await import("../pipeline/stages/4-code.js");
    const ctx = makeCtx({ dryRun: true });
    (ctx.config.workspace as Record<string, unknown>).buildCommand =
      "npm run build";
    writeTicketCtx(ctx.memoryDir, "## Summary\nAdd feature");
    const out = await codeStage.run(ctx);
    expect(typeof out.branchName).toBe("string");
  });

  it("uses default timeouts when config.pipeline is undefined", async () => {
    const { runAgent } = await import("../pipeline/runner.js");
    (runAgent as ReturnType<typeof vi.fn>).mockResolvedValueOnce("done");
    const { codeStage } = await import("../pipeline/stages/4-code.js");
    const ctx = makeCtx({ dryRun: false });
    (ctx.config as Record<string, unknown>).pipeline = undefined;
    writeTicketCtx(ctx.memoryDir, "## Summary\nFix bug");
    await codeStage.run(ctx);
    expect(runAgent).toHaveBeenCalledOnce();
  });

  it("uses 'implementation' slug when summary line is all special chars", async () => {
    const { codeStage } = await import("../pipeline/stages/4-code.js");
    const ctx = makeCtx({ dryRun: true });
    writeTicketCtx(ctx.memoryDir, "## Summary\n!!! @@@ ###");
    const out = await codeStage.run(ctx);
    expect(out.branchName).toContain("implementation");
  });

  it("uses 'implementation' when summaryLine is the last line (no next line)", async () => {
    const { codeStage } = await import("../pipeline/stages/4-code.js");
    const ctx = makeCtx({ dryRun: true });
    writeTicketCtx(ctx.memoryDir, "## Summary"); // no line after Summary
    const out = await codeStage.run(ctx);
    expect(out.branchName).toContain("implementation");
  });

  it("uses empty slug path when no summaryLine in ticket ctx", async () => {
    const { codeStage } = await import("../pipeline/stages/4-code.js");
    const ctx = makeCtx({ dryRun: true });
    writeTicketCtx(ctx.memoryDir, "No summary header here\n");
    const out = await codeStage.run(ctx);
    expect(typeof out.branchName).toBe("string");
  });
});

// ── gitStage ?? fallbacks ─────────────────────────────────────────────────────

describe("gitStage ?? fallbacks", () => {
  it("falls back to ticketKey summary when no summaryLine found", async () => {
    const { gitStage } = await import("../pipeline/stages/5-git.js");
    const ctx = makeCtx({ dryRun: true });
    ctx.state.current.branchName = "feature/HI-200-fix";
    // trailing \n → indexOf("") at last pos → array[last+1] = undefined → ?? ticketKey
    writeTicketCtx(ctx.memoryDir, "No summary\n");
    const out = await gitStage.run(ctx);
    expect(out.branchName).toBe("feature/HI-200-fix");
  });

  it("uses 'main' and false when defaultBranch and prDraftByDefault are undefined", async () => {
    const { gitStage } = await import("../pipeline/stages/5-git.js");
    const ctx = makeCtx({ dryRun: false });
    ctx.state.current.branchName = "feature/HI-200-test";
    (ctx.config.github as Record<string, unknown>).defaultBranch = undefined;
    (ctx.config.github as Record<string, unknown>).prDraftByDefault = undefined;
    writeTicketCtx(ctx.memoryDir, "## Summary\nFix");
    const out = await gitStage.run(ctx);
    expect(out.prNumber).toBe(42);
  });
});

// ── deployStage ?? fallbacks ──────────────────────────────────────────────────

describe("deployStage ?? fallbacks", () => {
  it("uses empty env object and default timeout when both are undefined", async () => {
    const { deployStage } = await import("../pipeline/stages/7-deploy.js");
    const ctx = makeCtx({ dryRun: false });
    ctx.config.deploy.enabled = true;
    (ctx.config.deploy as Record<string, unknown>).command = "echo";
    (ctx.config.deploy as Record<string, unknown>).env = undefined;
    (ctx.config.deploy as Record<string, unknown>).timeoutMs = undefined;
    const out = await deployStage.run(ctx);
    expect(out.deployed).toBe(true);
  });

  it("uses default healthCheckTimeoutMs when it is undefined", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue({ ok: true } as Response);
    const { deployStage } = await import("../pipeline/stages/7-deploy.js");
    const ctx = makeCtx({ dryRun: false });
    ctx.config.deploy.enabled = true;
    (ctx.config.deploy as Record<string, unknown>).command = "echo";
    (ctx.config.deploy as Record<string, unknown>).healthCheckUrl =
      "http://localhost/health";
    (ctx.config.deploy as Record<string, unknown>).healthCheckTimeoutMs =
      undefined;
    const out = await deployStage.run(ctx);
    expect(out.deployed).toBe(true);
    fetchSpy.mockRestore();
  });
});

// ── testStage ?? fallbacks ────────────────────────────────────────────────────

describe("testStage ?? fallbacks", () => {
  it("uses default timeoutMs when testConfig.timeoutMs is undefined", async () => {
    const { runAgent } = await import("../pipeline/runner.js");
    (runAgent as ReturnType<typeof vi.fn>).mockResolvedValue(
      '{"passed":true,"summary":"ok","failures":[]}',
    );
    const { testStage } = await import("../pipeline/stages/8-test.js");
    const ctx = makeCtx({ dryRun: false });
    ctx.config.test.enabled = true;
    (ctx.config.test as Record<string, unknown>).baseUrl =
      "http://localhost:3000";
    (ctx.config.test as Record<string, unknown>).timeoutMs = undefined;
    ctx.config.test.waitBeforeTestMs = 0;
    const out = await testStage.run(ctx);
    expect(out.passed).toBe(true);
  });

  it("wraps non-Error thrown by runAgent in a new Error", async () => {
    const { runAgent } = await import("../pipeline/runner.js");
    (runAgent as ReturnType<typeof vi.fn>).mockRejectedValue("string error");
    const { testStage } = await import("../pipeline/stages/8-test.js");
    const ctx = makeCtx({ dryRun: false });
    ctx.config.test.enabled = true;
    (ctx.config.test as Record<string, unknown>).baseUrl =
      "http://localhost:3000";
    ctx.config.test.retries = 0;
    ctx.config.test.waitBeforeTestMs = 0;
    ctx.config.pipeline!.failOnTestFailure = false;
    const out = await testStage.run(ctx);
    expect(out.passed).toBe(false);
  });

  it("uses false failOnTestFailure when pipeline is undefined", async () => {
    const { runAgent } = await import("../pipeline/runner.js");
    (runAgent as ReturnType<typeof vi.fn>).mockResolvedValue(
      '{"passed":false,"summary":"fail","failures":["F"]}',
    );
    const { testStage } = await import("../pipeline/stages/8-test.js");
    const ctx = makeCtx({ dryRun: false });
    ctx.config.test.enabled = true;
    (ctx.config.test as Record<string, unknown>).baseUrl =
      "http://localhost:3000";
    ctx.config.test.retries = 0;
    ctx.config.test.waitBeforeTestMs = 0;
    (ctx.config as Record<string, unknown>).pipeline = undefined;
    const out = await testStage.run(ctx);
    expect(out.passed).toBe(false);
  });

  it("uses 'Tests failed' summary fallback when lastError is undefined (retries=-1)", async () => {
    const { testStage } = await import("../pipeline/stages/8-test.js");
    const ctx = makeCtx({ dryRun: false });
    ctx.config.test.enabled = true;
    (ctx.config.test as Record<string, unknown>).baseUrl =
      "http://localhost:3000";
    (ctx.config.test as Record<string, unknown>).retries = -1; // loop never runs
    ctx.config.test.waitBeforeTestMs = 0;
    ctx.config.pipeline!.failOnTestFailure = false;
    const out = await testStage.run(ctx);
    expect(out.passed).toBe(false);
    expect(out.summary).toBe("Tests failed");
  });

  it("uses default waitBeforeTestMs, retries and specPattern when they are undefined", async () => {
    vi.useFakeTimers();
    const { runAgent } = await import("../pipeline/runner.js");
    (runAgent as ReturnType<typeof vi.fn>).mockResolvedValue(
      '{"passed":true,"summary":"ok","failures":[]}',
    );
    const { testStage } = await import("../pipeline/stages/8-test.js");
    const ctx = makeCtx({ dryRun: false });
    ctx.config.test.enabled = true;
    (ctx.config.test as Record<string, unknown>).baseUrl =
      "http://localhost:3000";
    (ctx.config.test as Record<string, unknown>).waitBeforeTestMs = undefined;
    (ctx.config.test as Record<string, unknown>).retries = undefined;
    (ctx.config.test as Record<string, unknown>).specPattern = undefined;

    const promise = testStage.run(ctx);
    await vi.runAllTimersAsync();
    const out = await promise;
    expect(out.passed).toBe(true);
    vi.useRealTimers();
  });

  it("throws 'Tests failed after all retries' when failOnTest=true and lastError undefined", async () => {
    const { testStage } = await import("../pipeline/stages/8-test.js");
    const ctx = makeCtx({ dryRun: false });
    ctx.config.test.enabled = true;
    (ctx.config.test as Record<string, unknown>).baseUrl =
      "http://localhost:3000";
    (ctx.config.test as Record<string, unknown>).retries = -1; // loop never runs
    ctx.config.test.waitBeforeTestMs = 0;
    ctx.config.pipeline!.failOnTestFailure = true;
    await expect(testStage.run(ctx)).rejects.toThrow(
      "Tests failed after all retries",
    );
  });
});

// ── reviewStage additional ?? branches ───────────────────────────────────────

describe("reviewStage ?? fallbacks", () => {
  it("uses default approval timeouts when humanInTheLoop is undefined", async () => {
    const { requestApproval } =
      await import("../integrations/telegram/human-loop.js");
    const { runAgentsParallel } = await import("../pipeline/runner.js");
    (runAgentsParallel as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      '{"issues":[{"severity":"major","message":"Big issue"}]}',
      '{"issues":[]}',
    ]);
    (requestApproval as ReturnType<typeof vi.fn>).mockResolvedValueOnce(true);
    const { reviewStage } = await import("../pipeline/stages/6-review.js");
    const ctx = makeCtx({ dryRun: false });
    ctx.state.current.prNumber = 30;
    (ctx.config.telegram as Record<string, unknown>).humanInTheLoop = undefined;
    fs.mkdirSync(ctx.memoryDir, { recursive: true });
    const out = await reviewStage.run(ctx);
    expect(out.merged).toBe(true);
  });

  it("uses 'squash' fallback when autoMergeStrategy is undefined", async () => {
    const { reviewStage } = await import("../pipeline/stages/6-review.js");
    const ctx = makeCtx({ dryRun: false });
    ctx.state.current.prNumber = 31;
    (ctx.config.github as Record<string, unknown>).autoMergeStrategy =
      undefined;
    fs.mkdirSync(ctx.memoryDir, { recursive: true });
    const out = await reviewStage.run(ctx);
    expect(out.merged).toBe(true);
    expect(ctx.github.mergePR).toHaveBeenCalledWith(31, "squash");
  });

  it("returns empty issues when parsed JSON has no issues field", async () => {
    const { runAgentsParallel } = await import("../pipeline/runner.js");
    // Valid JSON but no 'issues' field → parsed.issues ?? [] → []
    (runAgentsParallel as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      "{}",
      "{}",
    ]);
    const { reviewStage } = await import("../pipeline/stages/6-review.js");
    const ctx = makeCtx({ dryRun: false });
    ctx.state.current.prNumber = 32;
    fs.mkdirSync(ctx.memoryDir, { recursive: true });
    const out = await reviewStage.run(ctx);
    expect((out.issues as unknown[]).length).toBe(0);
  });

  it("uses default review timeout and majorIssueThreshold when both are undefined", async () => {
    const { runAgentsParallel } = await import("../pipeline/runner.js");
    (runAgentsParallel as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      '{"issues":[]}',
      '{"issues":[]}',
    ]);
    const { reviewStage } = await import("../pipeline/stages/6-review.js");
    const ctx = makeCtx({ dryRun: false });
    ctx.state.current.prNumber = 33;
    (ctx.config as Record<string, unknown>).pipeline = undefined;
    (ctx.config.github as Record<string, unknown>).majorIssueThreshold =
      undefined;
    fs.mkdirSync(ctx.memoryDir, { recursive: true });
    const out = await reviewStage.run(ctx);
    expect(out.merged).toBe(true);
  });

  it("skips the approval gate in dryRun without approving or merging", async () => {
    const { reviewStage } = await import("../pipeline/stages/6-review.js");
    const ctx = makeCtx({ dryRun: true });
    ctx.state.current.prNumber = 34;
    // Force needsHumanApproval by lowering threshold to 0 so even 0 major issues triggers it
    (ctx.config.github as Record<string, unknown>).majorIssueThreshold = 0;
    fs.mkdirSync(ctx.memoryDir, { recursive: true });
    const out = await reviewStage.run(ctx);
    expect(out.merged).toBe(false);
    expect(ctx.github.mergePR).not.toHaveBeenCalled();
    expect(ctx.state.emit).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "HUMAN_APPROVED" }),
    );
  });
});

// ── reviewStage parseIssues catch ─────────────────────────────────────────────

describe("reviewStage parseIssues catch branch", () => {
  it("catches JSON parse error when agent output has braces but invalid JSON", async () => {
    const { runAgentsParallel } = await import("../pipeline/runner.js");
    // Matches regex /\{[\s\S]*\}/ but JSON.parse throws
    (runAgentsParallel as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      "{ invalid: json here }",
      '{"issues":[]}',
    ]);
    const { reviewStage } = await import("../pipeline/stages/6-review.js");
    const ctx = makeCtx({ dryRun: false });
    ctx.state.current.prNumber = 20;
    fs.mkdirSync(ctx.memoryDir, { recursive: true });
    const out = await reviewStage.run(ctx);
    expect(Array.isArray(out.issues)).toBe(true);
    expect((out.issues as unknown[]).length).toBe(0);
  });
});

// ── notifyStage ?? fallbacks ──────────────────────────────────────────────────

describe("notifyStage ?? fallbacks", () => {
  it("includes PR and branch info in comment when state has prNumber and branchName", async () => {
    const jiraGet = vi.fn().mockResolvedValue({
      data: { transitions: [{ id: "31", name: "Done" }] },
    });
    const jiraPost = vi.fn().mockResolvedValue({ data: {} });
    const ctx = makeCtx();
    ctx.state.current.prNumber = 42;
    ctx.state.current.branchName = "feature/HI-200-fix";
    (ctx.jira as unknown as Record<string, unknown>).get = jiraGet;
    (ctx.jira as unknown as Record<string, unknown>).post = jiraPost;
    const { notifyStage } = await import("../pipeline/stages/9-notify.js");

    await notifyStage.run(ctx);
    const commentCall = jiraPost.mock.calls.find(
      (c: unknown[]) => (c as string[])[0] === "/issue/HI-200/comment",
    );
    expect(commentCall).toBeDefined();
    const body = JSON.stringify(commentCall![1]);
    expect(body).toContain("42");
    expect(body).toContain("feature/HI-200-fix");
  });

  it("uses 'Done' fallback when doneTransition is undefined", async () => {
    const jiraGet = vi.fn().mockResolvedValue({
      data: { transitions: [{ id: "31", name: "Done" }] },
    });
    const jiraPost = vi.fn().mockResolvedValue({ data: {} });
    const ctx = makeCtx();
    (ctx.config.jira as Record<string, unknown>).doneTransition = undefined;
    (ctx.jira as unknown as Record<string, unknown>).get = jiraGet;
    (ctx.jira as unknown as Record<string, unknown>).post = jiraPost;
    const { notifyStage } = await import("../pipeline/stages/9-notify.js");

    await notifyStage.run(ctx);
    expect(jiraPost).toHaveBeenCalledWith(
      "/issue/HI-200/transitions",
      expect.any(Object),
    );
  });
});
