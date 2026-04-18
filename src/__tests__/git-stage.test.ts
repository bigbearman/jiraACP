/**
 * TDD: git stage — idempotent sub-steps
 *
 * The git stage has 3 sequential sub-steps:
 *   1. git push origin <branch>
 *   2. github.createPR(...)
 *   3. github.addReviewers(...)
 *
 * Each sub-step is idempotent: if the work is already done, skip it and
 * continue to the next sub-step — do NOT throw.
 *
 * Sub-step 1 — git push:
 *   - branch already exists on remote → skip push, proceed to createPR
 *   - permission denied               → throw GIT_AUTH_FAILED (unrecoverable)
 *   - generic error                   → throw GIT_PUSH_FAILED (unrecoverable)
 *
 * Sub-step 2 — createPR:
 *   - PR already open for branch → call findOpenPR, use existing PR number
 *   - findOpenPR returns null    → throw PR_NOT_FOUND (can't recover)
 *   - generic API error          → throw GITHUB_CREATE_PR_FAILED (unrecoverable)
 *
 * Sub-step 3 — addReviewers:
 *   - only called when reviewers are configured (existing behavior, no change)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PipelineContext } from "../pipeline/stages/types.js";
import type { Logger } from "pino";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockSpawnSafe = vi.fn();
vi.mock("../utils/process.js", () => ({
  spawnSafe: mockSpawnSafe,
  buildMinimalEnv: vi.fn().mockReturnValue({}),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-stage-test-"));
  mockSpawnSafe.mockClear();
  mockSpawnSafe.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.resetModules();
});

const BRANCH = "feature/HI-100-fix-login";

function makeCtx(
  githubOverrides: Partial<PipelineContext["github"]> = {},
): PipelineContext {
  return {
    ticketKey: "HI-100",
    projectDir: tmpDir,
    memoryDir: path.join(tmpDir, "memory"),
    dryRun: false,
    config: {
      name: "test",
      jira: {
        instance: "hi",
        url: "https://test.atlassian.net",
        email: "dev@test.com",
        token: "t",
        projectKey: "HI",
        assignees: [],
        acceptanceCriteriaField: "customfield_10014",
      },
      github: {
        owner: "org",
        repo: "repo",
        token: "ghp",
        defaultBranch: "main",
        reviewers: [],
        prDraftByDefault: false,
      },
      workspace: { rootDir: tmpDir },
      telegram: { botToken: "123:ABC", chatId: "-100" },
    } as PipelineContext["config"],
    jira: {} as PipelineContext["jira"],
    github: {
      createPR: vi.fn().mockResolvedValue(42),
      findOpenPR: vi.fn().mockResolvedValue(null),
      addReviewers: vi.fn().mockResolvedValue(undefined),
      mergePR: vi.fn(),
      ...githubOverrides,
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
    } as PipelineContext["telegram"],
    state: {
      emit: vi.fn(),
      current: {
        ticketKey: "HI-100",
        currentStage: null,
        completedStages: ["fetch", "analyze", "code"],
        failedStage: null,
        pendingClarification: false,
        pendingHumanApproval: false,
        branchName: BRANCH,
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
  };
}

// ── Sub-step 1: git push ──────────────────────────────────────────────────────

describe("gitStage sub-step 1 — push: branch already exists (idempotent)", () => {
  it("does NOT throw — continues to next sub-step", async () => {
    mockSpawnSafe.mockResolvedValueOnce({
      stdout: "",
      stderr: "error: failed to push some refs — branch already exists",
      exitCode: 1,
    });
    const { gitStage } = await import("../pipeline/stages/5-git.js");
    await expect(gitStage.run(makeCtx())).resolves.toBeDefined();
  });

  it("still calls createPR after skipping push", async () => {
    mockSpawnSafe.mockResolvedValueOnce({
      stdout: "",
      stderr: "error: src refspec feature/HI-100-fix-login already exists",
      exitCode: 1,
    });
    const createPR = vi.fn().mockResolvedValue(55);
    const { gitStage } = await import("../pipeline/stages/5-git.js");
    await gitStage.run(makeCtx({ createPR }));
    expect(createPR).toHaveBeenCalledOnce();
  });

  it("returns prNumber from createPR even when push was skipped", async () => {
    mockSpawnSafe.mockResolvedValueOnce({
      stdout: "",
      stderr: "error: src refspec already exists in remote",
      exitCode: 1,
    });
    const { gitStage } = await import("../pipeline/stages/5-git.js");
    const output = await gitStage.run(
      makeCtx({ createPR: vi.fn().mockResolvedValue(77) }),
    );
    expect(output.prNumber).toBe(77);
  });

  it("logs a warning (not an error) when push is skipped", async () => {
    mockSpawnSafe.mockResolvedValueOnce({
      stdout: "",
      stderr: "error: branch already exists",
      exitCode: 1,
    });
    const ctx = makeCtx();
    const { gitStage } = await import("../pipeline/stages/5-git.js");
    await gitStage.run(ctx);
    expect(ctx.logger.warn as ReturnType<typeof vi.fn>).toHaveBeenCalled();
    expect(ctx.logger.error as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });
});

describe("gitStage sub-step 1 — push: permission denied (unrecoverable)", () => {
  it("throws GIT_AUTH_FAILED", async () => {
    mockSpawnSafe.mockResolvedValueOnce({
      stdout: "",
      stderr: "ERROR: Permission to org/repo.git denied to deploy-key.",
      exitCode: 128,
    });
    const { gitStage } = await import("../pipeline/stages/5-git.js");
    await expect(gitStage.run(makeCtx())).rejects.toThrow(/GIT_AUTH_FAILED/);
  });
});

describe("gitStage sub-step 1 — push: generic error (unrecoverable)", () => {
  it("throws GIT_PUSH_FAILED with the original stderr", async () => {
    const stderr = "error: RPC failed; HTTP 500";
    mockSpawnSafe.mockResolvedValueOnce({ stdout: "", stderr, exitCode: 1 });
    const { gitStage } = await import("../pipeline/stages/5-git.js");
    await expect(gitStage.run(makeCtx())).rejects.toThrow(/GIT_PUSH_FAILED/);
  });

  it("includes the original stderr in the error message", async () => {
    const stderr = "error: RPC failed; HTTP 500";
    mockSpawnSafe.mockResolvedValueOnce({ stdout: "", stderr, exitCode: 1 });
    const { gitStage } = await import("../pipeline/stages/5-git.js");
    await expect(gitStage.run(makeCtx())).rejects.toThrow(stderr);
  });
});

// ── Sub-step 2: createPR ──────────────────────────────────────────────────────

describe("gitStage sub-step 2 — createPR: PR already open (idempotent)", () => {
  it("does NOT throw — calls findOpenPR to recover the existing PR number", async () => {
    const ctx = makeCtx({
      createPR: vi
        .fn()
        .mockRejectedValue(
          new Error(
            "Validation Failed: A pull request already exists for this branch",
          ),
        ),
      findOpenPR: vi.fn().mockResolvedValue(99),
    });
    const { gitStage } = await import("../pipeline/stages/5-git.js");
    await expect(gitStage.run(ctx)).resolves.toBeDefined();
  });

  it("calls findOpenPR with the branch name", async () => {
    const findOpenPR = vi.fn().mockResolvedValue(99);
    const ctx = makeCtx({
      createPR: vi
        .fn()
        .mockRejectedValue(
          new Error(
            "A pull request already exists for org:feature/HI-100-fix-login",
          ),
        ),
      findOpenPR,
    });
    const { gitStage } = await import("../pipeline/stages/5-git.js");
    await gitStage.run(ctx);
    expect(findOpenPR).toHaveBeenCalledWith(BRANCH);
  });

  it("returns the existing PR number found by findOpenPR", async () => {
    const ctx = makeCtx({
      createPR: vi
        .fn()
        .mockRejectedValue(
          new Error("A pull request already exists for this branch"),
        ),
      findOpenPR: vi.fn().mockResolvedValue(99),
    });
    const { gitStage } = await import("../pipeline/stages/5-git.js");
    const output = await gitStage.run(ctx);
    expect(output.prNumber).toBe(99);
  });

  it("throws PR_NOT_FOUND when createPR says 'already exists' but findOpenPR returns null", async () => {
    const ctx = makeCtx({
      createPR: vi
        .fn()
        .mockRejectedValue(
          new Error("A pull request already exists for this branch"),
        ),
      findOpenPR: vi.fn().mockResolvedValue(null),
    });
    const { gitStage } = await import("../pipeline/stages/5-git.js");
    await expect(gitStage.run(ctx)).rejects.toThrow(/PR_NOT_FOUND/);
  });
});

describe("gitStage sub-step 2 — createPR: generic GitHub API error (unrecoverable)", () => {
  it("throws GITHUB_CREATE_PR_FAILED", async () => {
    const ctx = makeCtx({
      createPR: vi
        .fn()
        .mockRejectedValue(new Error("GitHub API rate limit exceeded")),
    });
    const { gitStage } = await import("../pipeline/stages/5-git.js");
    await expect(gitStage.run(ctx)).rejects.toThrow(/GITHUB_CREATE_PR_FAILED/);
  });

  it("includes the original error message", async () => {
    const ctx = makeCtx({
      createPR: vi
        .fn()
        .mockRejectedValue(new Error("GitHub API rate limit exceeded")),
    });
    const { gitStage } = await import("../pipeline/stages/5-git.js");
    await expect(gitStage.run(ctx)).rejects.toThrow("rate limit exceeded");
  });
});

// ── Happy path ────────────────────────────────────────────────────────────────

describe("gitStage — success path (no prior work on remote)", () => {
  it("returns branchName and prNumber on full success", async () => {
    const output = await (async () => {
      const { gitStage } = await import("../pipeline/stages/5-git.js");
      return gitStage.run(makeCtx({ createPR: vi.fn().mockResolvedValue(42) }));
    })();
    expect(output.branchName).toBe(BRANCH);
    expect(output.prNumber).toBe(42);
  });

  it("calls git push with the correct branch name", async () => {
    const { gitStage } = await import("../pipeline/stages/5-git.js");
    await gitStage.run(makeCtx());
    expect(mockSpawnSafe).toHaveBeenCalledWith(
      "git",
      ["push", "origin", BRANCH],
      expect.anything(),
    );
  });

  it("skips push and createPR in dry-run mode, returns prNumber null", async () => {
    const createPR = vi.fn();
    const ctx = makeCtx({ createPR });
    ctx.dryRun = true;
    const { gitStage } = await import("../pipeline/stages/5-git.js");
    const output = await gitStage.run(ctx);
    expect(mockSpawnSafe).not.toHaveBeenCalled();
    expect(createPR).not.toHaveBeenCalled();
    expect(output.prNumber).toBeNull();
  });
});
