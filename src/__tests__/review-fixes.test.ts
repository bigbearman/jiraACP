import { describe, it, expect, vi } from "vitest";
import type { Logger } from "pino";
import type { GitHubClient, CheckRun } from "../integrations/github/client.js";
import { waitForCI, type CIPollConfig } from "../pipeline/ci-poller.js";
import { escapeHtml, splitHtmlByLines } from "../utils/html.js";
import { isAuthorized } from "../integrations/telegram/bot.js";

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const poll: CIPollConfig = {
  timeoutMs: 200,
  initialMs: 1,
  multiplier: 1,
  maxMs: 1,
  requiredChecks: [],
  noChecksGraceMs: 30,
};

const run = (
  name: string,
  status: string,
  conclusion: string | null,
): CheckRun => ({
  id: 1,
  name,
  status,
  conclusion,
  startedAt: null,
  completedAt: null,
});

function github(...responses: CheckRun[][]): GitHubClient {
  const getCheckRuns = vi.fn();
  responses.forEach((r, i) =>
    i < responses.length - 1
      ? getCheckRuns.mockResolvedValueOnce(r)
      : getCheckRuns.mockResolvedValue(r),
  );
  return {
    getCheckRuns,
    getCheckRunLog: vi.fn().mockResolvedValue("log"),
  } as unknown as GitHubClient;
}

describe("waitForCI", () => {
  it("does not report success before check runs are registered", async () => {
    const result = await waitForCI(
      github([], [run("build", "completed", "failure")]),
      "sha",
      poll,
      logger,
    );
    expect(result.status).toBe("failure");
  });

  it("treats a repo with no checks as success only after the grace period", async () => {
    const result = await waitForCI(github([]), "sha", poll, logger);
    expect(result.status).toBe("success");
    expect(result.durationMs).toBeGreaterThanOrEqual(poll.noChecksGraceMs);
  });

  it("times out while a required check has not appeared", async () => {
    const result = await waitForCI(
      github([run("lint", "completed", "success")]),
      "sha",
      { ...poll, timeoutMs: 20, requiredChecks: ["build"] },
      logger,
    );
    expect(result.status).toBe("timeout");
    expect(result.pendingChecks).toEqual(["build"]);
  });

  it("counts skipped and neutral checks as passing", async () => {
    const result = await waitForCI(
      github([
        run("a", "completed", "success"),
        run("b", "completed", "skipped"),
        run("c", "completed", "neutral"),
      ]),
      "sha",
      poll,
      logger,
    );
    expect(result).toMatchObject({
      status: "success",
      passedCount: 3,
      failedCount: 0,
    });
  });
});

describe("telegram html helpers", () => {
  it("escapes markup characters", () => {
    expect(escapeHtml('<a href="x">&')).toBe('&lt;a href="x"&gt;&amp;');
  });

  it("splits long messages at line breaks and keeps all content", () => {
    const html = Array.from({ length: 50 }, (_, i) => `<b>line ${i}</b>`).join(
      "\n",
    );
    const chunks = splitHtmlByLines(html, 100);
    expect(chunks.every((c) => c.length <= 100)).toBe(true);
    expect(chunks.join("\n")).toBe(html);
    // every chunk keeps its tags balanced
    for (const c of chunks) {
      expect(c.match(/<b>/g)?.length).toBe(c.match(/<\/b>/g)?.length);
    }
  });

  it("re-cuts a single oversized line as escaped plain text", () => {
    const chunks = splitHtmlByLines(`<b>${"&amp;".repeat(100)}</b>`, 100);
    expect(chunks.every((c) => c.length <= 100)).toBe(true);
    expect(chunks.join("")).toBe("&amp;".repeat(100));
  });
});

describe("isAuthorized", () => {
  const chatOnly = { project: "a", chatId: "-100", userIds: [] };
  const usersOnly = { project: "b", chatId: "-100", userIds: [7] };
  const sender = (id: number | undefined, userId?: number, username?: string) => ({
    chat: id === undefined ? undefined : { id, username },
    userId,
  });

  it("accepts only the configured chat when no user list is set", () => {
    expect(isAuthorized(chatOnly, sender(-100, 1))).toBe(true);
    expect(isAuthorized(chatOnly, sender(555, 1))).toBe(false);
    expect(isAuthorized(chatOnly, sender(undefined, 1))).toBe(false);
  });

  it("accepts only listed users when a user list is set", () => {
    expect(isAuthorized(usersOnly, sender(555, 7))).toBe(true);
    expect(isAuthorized(usersOnly, sender(-100, 8))).toBe(false);
    expect(isAuthorized(usersOnly, sender(-100))).toBe(false);
  });

  it("matches @username chats case-insensitively", () => {
    const rule = { project: "c", chatId: "@myteam", userIds: [] };
    expect(isAuthorized(rule, sender(1, 1, "MyTeam"))).toBe(true);
    expect(isAuthorized(rule, sender(1, 1, "other"))).toBe(false);
  });
});
