/**
 * Merge gate: with default config every merge waits for a human to approve
 * it in Telegram, even when both review agents report zero issues.
 * Auto-merge needs the explicit github.autoMergeWithoutHumanApproval flag.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Logger } from "pino";
import type { PipelineContext } from "../pipeline/stages/types.js";
import type { TelegramNotifier } from "../integrations/telegram/notifier.js";
import { ProjectConfigSchema } from "../config/schema.js";
import type { ProjectConfig } from "../config/schema.js";

vi.mock("../pipeline/runner.js", () => ({
  runAgent: vi.fn(),
  runAgentsParallel: vi
    .fn()
    .mockResolvedValue(['{"issues":[]}', '{"issues":[]}']),
  detectComplexity: vi.fn(() => "sonnet" as const),
}));

vi.mock("../integrations/telegram/human-loop.js", () => ({
  requestClarification: vi.fn(),
  requestApproval: vi.fn(),
}));

const { runAgentsParallel } = await import("../pipeline/runner.js");
const { requestApproval } =
  await import("../integrations/telegram/human-loop.js");
const { reviewStage } = await import("../pipeline/stages/6-review.js");

// Minimal user-written config; everything else comes from schema defaults
function parseConfig(
  overrides: {
    github?: Record<string, unknown>;
    humanInTheLoop?: Record<string, unknown>;
  } = {},
): ProjectConfig {
  return ProjectConfigSchema.parse({
    name: "test",
    jira: {
      instance: "t",
      url: "https://test.atlassian.net",
      email: "dev@test.com",
      token: "token",
      projectKey: "T",
      assignees: ["me"],
    },
    github: { owner: "org", repo: "repo", token: "gh", ...overrides.github },
    workspace: { rootDir: "/tmp" },
    telegram: {
      botToken: "bot",
      chatId: "1",
      humanInTheLoop: overrides.humanInTheLoop,
    },
  });
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jira-merge-gate-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

function makeCtx(
  config: ProjectConfig,
  dryRun = false,
): PipelineContext & {
  github: { mergePR: ReturnType<typeof vi.fn> };
  logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };
} {
  return {
    ticketKey: "T-1",
    projectDir: tmpDir,
    memoryDir: path.join(tmpDir, "memory"),
    dryRun,
    config,
    jira: {} as PipelineContext["jira"],
    github: {
      mergePR: vi.fn().mockResolvedValue(undefined),
    } as unknown as PipelineContext["github"],
    telegram: {
      updateDetail: vi.fn().mockResolvedValue(undefined),
    } as unknown as TelegramNotifier,
    state: {
      emit: vi.fn(),
      current: { prNumber: 42 },
    } as unknown as PipelineContext["state"],
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as Logger,
  } as unknown as ReturnType<typeof makeCtx>;
}

describe("config defaults", () => {
  it("keeps auto-merge, deploy and test off", () => {
    const config = parseConfig();
    expect(config.github.autoMergeWithoutHumanApproval).toBe(false);
    expect(config.deploy.enabled).toBe(false);
    expect(config.test.enabled).toBe(false);
  });
});

describe("reviewStage — default config", () => {
  it("waits for human approval even when reviewers report 0 issues", async () => {
    let approve: (value: boolean) => void = () => undefined;
    vi.mocked(requestApproval).mockReturnValue(
      new Promise<boolean>((resolve) => {
        approve = resolve;
      }),
    );
    const ctx = makeCtx(parseConfig());

    const run = reviewStage.run(ctx);
    await vi.waitFor(() => expect(requestApproval).toHaveBeenCalledOnce());

    // Approval is pending: nothing may be merged yet
    await new Promise((r) => setTimeout(r, 20));
    expect(ctx.github.mergePR).not.toHaveBeenCalled();
    expect(vi.mocked(requestApproval).mock.calls[0][3]).toEqual([]);

    approve(true);
    await expect(run).resolves.toMatchObject({ prNumber: 42, merged: true });
    expect(ctx.github.mergePR).toHaveBeenCalledWith(42, "squash");
  });

  it("does not merge when the human rejects", async () => {
    vi.mocked(requestApproval).mockResolvedValue(false);
    const ctx = makeCtx(parseConfig());

    await expect(reviewStage.run(ctx)).rejects.toThrow("REVIEW_REJECTED");
    expect(ctx.github.mergePR).not.toHaveBeenCalled();
  });

  it("does not merge when the approval request times out", async () => {
    vi.mocked(requestApproval).mockRejectedValue(
      new Error("REVIEW_APPROVAL_TIMEOUT:T-1"),
    );
    const ctx = makeCtx(parseConfig());

    await expect(reviewStage.run(ctx)).rejects.toThrow(
      "REVIEW_APPROVAL_TIMEOUT",
    );
    expect(ctx.github.mergePR).not.toHaveBeenCalled();
  });

  it("downgrades a merge-anyway timeout to abort", async () => {
    vi.mocked(requestApproval).mockResolvedValue(true);
    const ctx = makeCtx(
      parseConfig({
        humanInTheLoop: { reviewApprovalTimeoutAction: "merge-anyway" },
      }),
    );

    await reviewStage.run(ctx);
    expect(vi.mocked(requestApproval).mock.calls[0][4].onTimeout).toBe("abort");
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('"merge-anyway" ignored'),
    );
  });

  it("ignores majorIssueThreshold while auto-merge is off", async () => {
    vi.mocked(requestApproval).mockResolvedValue(true);
    const ctx = makeCtx(parseConfig({ github: { majorIssueThreshold: 99 } }));

    await reviewStage.run(ctx);
    expect(requestApproval).toHaveBeenCalledOnce();
  });
});

describe("reviewStage — autoMergeWithoutHumanApproval: true", () => {
  it("merges a clean review without asking", async () => {
    const ctx = makeCtx(
      parseConfig({ github: { autoMergeWithoutHumanApproval: true } }),
    );

    await expect(reviewStage.run(ctx)).resolves.toMatchObject({
      merged: true,
    });
    expect(requestApproval).not.toHaveBeenCalled();
    expect(ctx.github.mergePR).toHaveBeenCalledOnce();
  });

  it("still asks when major issues reach the threshold", async () => {
    vi.mocked(runAgentsParallel).mockResolvedValueOnce([
      '{"issues":[{"severity":"major","message":"SQL injection"}]}',
      '{"issues":[]}',
    ]);
    vi.mocked(requestApproval).mockResolvedValue(true);
    const ctx = makeCtx(
      parseConfig({
        github: { autoMergeWithoutHumanApproval: true },
        humanInTheLoop: { reviewApprovalTimeoutAction: "merge-anyway" },
      }),
    );

    await reviewStage.run(ctx);
    expect(requestApproval).toHaveBeenCalledOnce();
    expect(vi.mocked(requestApproval).mock.calls[0][4].onTimeout).toBe(
      "merge-anyway",
    );
  });
});

describe("reviewStage — dry run", () => {
  it("never merges and logs that the approval gate was skipped", async () => {
    const ctx = makeCtx(parseConfig(), true);

    await expect(reviewStage.run(ctx)).resolves.toMatchObject({
      merged: false,
    });
    expect(requestApproval).not.toHaveBeenCalled();
    expect(ctx.github.mergePR).not.toHaveBeenCalled();
    expect(ctx.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ needsHumanApproval: true }),
      "Dry run — human approval gate skipped, PR not merged",
    );
  });
});
