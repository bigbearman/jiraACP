import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PipelineContext } from "../pipeline/stages/types.js";
import type { TelegramNotifier } from "../integrations/telegram/notifier.js";
import type { Logger } from "pino";

// ── Helpers ───────────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jira-fetch-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.resetModules();
});

function makeJiraResponse(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      key: "HI-558",
      fields: {
        summary: "Add login page",
        status: { name: "In Progress" },
        assignee: { displayName: "Kien Duong" },
        priority: { name: "High" },
        description: {
          type: "doc",
          version: 1,
          content: [
            {
              type: "paragraph",
              content: [
                { type: "text", text: "Build a login page with JWT auth." },
              ],
            },
          ],
        },
        customfield_10016: {
          type: "doc",
          version: 1,
          content: [
            {
              type: "bulletList",
              content: [
                {
                  type: "listItem",
                  content: [
                    {
                      type: "paragraph",
                      content: [
                        {
                          type: "text",
                          text: "User can log in with email + password",
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
        ...overrides,
      },
    },
  };
}

function makeCtx(jiraGet: ReturnType<typeof vi.fn>): PipelineContext {
  return {
    ticketKey: "HI-558",
    projectDir: tmpDir,
    memoryDir: path.join(tmpDir, "memory"),
    dryRun: false,
    config: {
      name: "test",
      jira: {
        instance: "hi",
        url: "https://test.atlassian.net",
        email: "dev@test.com",
        token: "token",
        projectKey: "HI",
        assignees: ["acc-1"],
        acceptanceCriteriaField: "customfield_10016",
        inProgressTransition: "In Progress",
        inReviewTransition: "In Review",
        doneTransition: "Done",
        clarityScoreThreshold: 0.7,
        requiredFields: ["description", "acceptanceCriteria"],
      },
      github: {
        owner: "org",
        repo: "repo",
        token: "ghp",
        defaultBranch: "main",
        branchPattern: "{prefix}/{ticketKey}-{slug}",
        branchPrefix: "feature",
        autoMergeStrategy: "squash",
        reviewers: [],
        prDraftByDefault: false,
        majorIssueThreshold: 1,
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
        retries: 2,
        waitBeforeTestMs: 5_000,
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
      get: jiraGet,
      post: vi.fn(),
      put: vi.fn(),
    } as unknown as PipelineContext["jira"],
    github: {} as PipelineContext["github"],
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
      current: {
        ticketKey: "HI-558",
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
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("fetchStage", () => {
  it("calls ctx.jira.get, NOT getClient(instance)", async () => {
    // This test would have caught the original bug:
    // if the stage called getClient('hi') it would throw 'Unknown Jira instance: hi'
    const jiraGet = vi.fn().mockResolvedValue(makeJiraResponse());
    const ctx = makeCtx(jiraGet);
    const { fetchStage } = await import("../pipeline/stages/1-fetch.js");

    await expect(fetchStage.run(ctx)).resolves.not.toThrow();
    expect(jiraGet).toHaveBeenCalledOnce();
    expect(jiraGet).toHaveBeenCalledWith(
      "/issue/HI-558",
      expect.objectContaining({ params: expect.any(Object) }),
    );
  });

  it("returns summary, status, assignee from Jira response", async () => {
    const jiraGet = vi.fn().mockResolvedValue(makeJiraResponse());
    const ctx = makeCtx(jiraGet);
    const { fetchStage } = await import("../pipeline/stages/1-fetch.js");

    const output = await fetchStage.run(ctx);
    expect(output.summary).toBe("Add login page");
    expect(output.status).toBe("In Progress");
    expect(output.assignee).toBe("Kien Duong");
  });

  it("extracts plain text from ADF description", async () => {
    const jiraGet = vi.fn().mockResolvedValue(makeJiraResponse());
    const ctx = makeCtx(jiraGet);
    const { fetchStage } = await import("../pipeline/stages/1-fetch.js");

    const output = await fetchStage.run(ctx);
    expect(output.description).toContain("Build a login page with JWT auth.");
  });

  it("writes ticket-context.md to memoryDir", async () => {
    const jiraGet = vi.fn().mockResolvedValue(makeJiraResponse());
    const ctx = makeCtx(jiraGet);
    const { fetchStage } = await import("../pipeline/stages/1-fetch.js");

    await fetchStage.run(ctx);
    const contextFile = path.join(tmpDir, "memory", "ticket-context.md");
    expect(fs.existsSync(contextFile)).toBe(true);
    const content = fs.readFileSync(contextFile, "utf8");
    expect(content).toContain("HI-558");
    expect(content).toContain("Add login page");
  });

  it("handles missing assignee gracefully", async () => {
    const jiraGet = vi
      .fn()
      .mockResolvedValue(makeJiraResponse({ assignee: null }));
    const ctx = makeCtx(jiraGet);
    const { fetchStage } = await import("../pipeline/stages/1-fetch.js");

    const output = await fetchStage.run(ctx);
    expect(output.assignee).toBe("Unassigned");
  });

  it("handles missing priority gracefully", async () => {
    const jiraGet = vi
      .fn()
      .mockResolvedValue(makeJiraResponse({ priority: null }));
    const ctx = makeCtx(jiraGet);
    const { fetchStage } = await import("../pipeline/stages/1-fetch.js");

    const output = await fetchStage.run(ctx);
    expect(output).toBeDefined();
  });

  it("throws if jira.get rejects (network error surfaces)", async () => {
    const jiraGet = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const ctx = makeCtx(jiraGet);
    const { fetchStage } = await import("../pipeline/stages/1-fetch.js");

    await expect(fetchStage.run(ctx)).rejects.toThrow("ECONNREFUSED");
  });

  it("handles null description (extractText falsy path)", async () => {
    const jiraGet = vi
      .fn()
      .mockResolvedValue(makeJiraResponse({ description: null }));
    const ctx = makeCtx(jiraGet);
    const { fetchStage } = await import("../pipeline/stages/1-fetch.js");
    const output = await fetchStage.run(ctx);
    expect(output.description).toBe(""); // extractText(null) → ""
  });

  it("handles string element inside ADF content (extractText string path)", async () => {
    const jiraGet = vi.fn().mockResolvedValue(
      makeJiraResponse({
        description: {
          type: "paragraph",
          content: ["direct string"], // string inside content array
        },
      }),
    );
    const ctx = makeCtx(jiraGet);
    const { fetchStage } = await import("../pipeline/stages/1-fetch.js");
    const output = await fetchStage.run(ctx);
    expect(output.description).toContain("direct string");
  });

  it("handles text node with no text field (n.text ?? '')", async () => {
    const jiraGet = vi.fn().mockResolvedValue(
      makeJiraResponse({
        description: { type: "doc", content: [{ type: "text" }] },
      }),
    );
    const ctx = makeCtx(jiraGet);
    const { fetchStage } = await import("../pipeline/stages/1-fetch.js");
    const output = await fetchStage.run(ctx);
    expect(output.description).toBe(""); // n.text ?? "" → ""
  });

  it("handles null summary gracefully (?? '' path)", async () => {
    const jiraGet = vi
      .fn()
      .mockResolvedValue(makeJiraResponse({ summary: null }));
    const ctx = makeCtx(jiraGet);
    const { fetchStage } = await import("../pipeline/stages/1-fetch.js");
    const output = await fetchStage.run(ctx);
    expect(output.summary).toBe(""); // null ?? "" → ""
  });

  it("handles null status gracefully (??.name ?? 'Unknown' path)", async () => {
    const jiraGet = vi
      .fn()
      .mockResolvedValue(makeJiraResponse({ status: null }));
    const ctx = makeCtx(jiraGet);
    const { fetchStage } = await import("../pipeline/stages/1-fetch.js");
    const output = await fetchStage.run(ctx);
    expect(output.status).toBe("Unknown");
  });

  it("returns empty string for ADF node with unknown type and no content", async () => {
    // Node with type "unknown" and no .content or .text — hits the final `return ""`
    const jiraGet = vi.fn().mockResolvedValue(
      makeJiraResponse({
        description: {
          type: "unknownBlock",
          // no content, no text
        },
      }),
    );
    const ctx = makeCtx(jiraGet);
    const { fetchStage } = await import("../pipeline/stages/1-fetch.js");

    const output = await fetchStage.run(ctx);
    expect(output.description).toBe("");
  });
});

describe("notifyStage", () => {
  it("calls ctx.jira.get for transitions, NOT getClient(instance)", async () => {
    const jiraGet = vi.fn().mockResolvedValue({
      data: { transitions: [{ id: "31", name: "Done" }] },
    });
    const jiraPost = vi.fn().mockResolvedValue({ data: {} });
    const ctx = makeCtx(jiraGet);
    (ctx.jira as unknown as Record<string, unknown>).post = jiraPost;
    const { notifyStage } = await import("../pipeline/stages/9-notify.js");

    await expect(notifyStage.run(ctx)).resolves.not.toThrow();
    expect(jiraGet).toHaveBeenCalledWith("/issue/HI-558/transitions");
  });

  it("posts Done transition to Jira", async () => {
    const jiraGet = vi.fn().mockResolvedValue({
      data: {
        transitions: [
          { id: "31", name: "Done" },
          { id: "11", name: "In Progress" },
        ],
      },
    });
    const jiraPost = vi.fn().mockResolvedValue({ data: {} });
    const ctx = makeCtx(jiraGet);
    (ctx.jira as unknown as Record<string, unknown>).post = jiraPost;
    const { notifyStage } = await import("../pipeline/stages/9-notify.js");

    await notifyStage.run(ctx);

    // First post: transition
    expect(jiraPost).toHaveBeenCalledWith("/issue/HI-558/transitions", {
      transition: { id: "31" },
    });
  });

  it("adds a comment to Jira", async () => {
    const jiraGet = vi.fn().mockResolvedValue({
      data: { transitions: [{ id: "31", name: "Done" }] },
    });
    const jiraPost = vi.fn().mockResolvedValue({ data: {} });
    const ctx = makeCtx(jiraGet);
    (ctx.jira as unknown as Record<string, unknown>).post = jiraPost;
    const { notifyStage } = await import("../pipeline/stages/9-notify.js");

    await notifyStage.run(ctx);

    const commentCall = jiraPost.mock.calls.find(
      (c) => c[0] === "/issue/HI-558/comment",
    );
    expect(commentCall).toBeDefined();
  });

  it("skips Jira calls in dry-run mode", async () => {
    const jiraGet = vi.fn();
    const jiraPost = vi.fn();
    const ctx = makeCtx(jiraGet);
    ctx.dryRun = true;
    (ctx.jira as unknown as Record<string, unknown>).post = jiraPost;
    const { notifyStage } = await import("../pipeline/stages/9-notify.js");

    const output = await notifyStage.run(ctx);
    expect(jiraGet).not.toHaveBeenCalled();
    expect(jiraPost).not.toHaveBeenCalled();
    expect(output.notified).toBe(true);
  });

  it("reassigns ticket when config.jira.reassignTo is set", async () => {
    const jiraGet = vi.fn().mockResolvedValue({
      data: { transitions: [{ id: "31", name: "Done" }] },
    });
    const jiraPost = vi.fn().mockResolvedValue({ data: {} });
    const jiraPut = vi.fn().mockResolvedValue({ data: {} });
    const ctx = makeCtx(jiraGet);
    (ctx.jira as unknown as Record<string, unknown>).post = jiraPost;
    (ctx.jira as unknown as Record<string, unknown>).put = jiraPut;
    (ctx.config.jira as Record<string, unknown>).reassignTo = "acc-reassign";
    const { notifyStage } = await import("../pipeline/stages/9-notify.js");

    await notifyStage.run(ctx);
    expect(jiraPut).toHaveBeenCalledWith("/issue/HI-558/assignee", {
      accountId: "acc-reassign",
    });
  });

  it("includes PR and branch info in comment when state has prNumber and branchName", async () => {
    const jiraGet = vi.fn().mockResolvedValue({
      data: { transitions: [{ id: "31", name: "Done" }] },
    });
    const jiraPost = vi.fn().mockResolvedValue({ data: {} });
    const ctx = makeCtx(jiraGet);
    ctx.state.current.prNumber = 99;
    ctx.state.current.branchName = "feature/HI-558-fix";
    (ctx.jira as unknown as Record<string, unknown>).post = jiraPost;
    const { notifyStage } = await import("../pipeline/stages/9-notify.js");

    await notifyStage.run(ctx);
    const commentCall = jiraPost.mock.calls.find(
      (c: unknown[]) => (c as string[])[0] === "/issue/HI-558/comment",
    );
    expect(commentCall).toBeDefined();
    const body = JSON.stringify(commentCall![1]);
    expect(body).toContain("99");
    expect(body).toContain("feature/HI-558-fix");
  });

  it("uses 'Done' fallback when doneTransition is undefined", async () => {
    const jiraGet = vi.fn().mockResolvedValue({
      data: { transitions: [{ id: "31", name: "Done" }] },
    });
    const jiraPost = vi.fn().mockResolvedValue({ data: {} });
    const ctx = makeCtx(jiraGet);
    (ctx.config.jira as Record<string, unknown>).doneTransition = undefined;
    (ctx.jira as unknown as Record<string, unknown>).post = jiraPost;
    const { notifyStage } = await import("../pipeline/stages/9-notify.js");

    await notifyStage.run(ctx);
    // doneTransition ?? "Done" — finds "Done" transition and posts it
    expect(jiraPost).toHaveBeenCalledWith(
      "/issue/HI-558/transitions",
      expect.any(Object),
    );
  });

  it("warns but continues if Done transition not found", async () => {
    const jiraGet = vi.fn().mockResolvedValue({
      data: { transitions: [{ id: "11", name: "In Progress" }] },
    });
    const jiraPost = vi.fn().mockResolvedValue({ data: {} });
    const ctx = makeCtx(jiraGet);
    (ctx.jira as unknown as Record<string, unknown>).post = jiraPost;
    const { notifyStage } = await import("../pipeline/stages/9-notify.js");

    await expect(notifyStage.run(ctx)).resolves.toBeDefined();
    // Transition not found → only comment post, no transition post
    const transitionCall = jiraPost.mock.calls.find(
      (c) => c[0] === "/issue/HI-558/transitions",
    );
    expect(transitionCall).toBeUndefined();
  });
});
