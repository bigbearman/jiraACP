/**
 * Tests for memory utilities: claude-md.ts and mcp-json.ts
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateClaudeMd } from "../memory/claude-md.js";
import { writeMcpJson } from "../memory/mcp-json.js";
import type { ProjectConfig } from "../config/schema.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jira-memory-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const baseConfig: ProjectConfig = {
  name: "myproject",
  jira: {
    instance: "hi",
    url: "https://test.atlassian.net",
    email: "dev@test.com",
    token: "token",
    projectKey: "HI",
    assignees: ["alice", "bob"],
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
};

// ── generateClaudeMd ──────────────────────────────────────────────────────────

describe("generateClaudeMd", () => {
  it("creates .claude/CLAUDE.md in projectDir", async () => {
    await generateClaudeMd(tmpDir, baseConfig);
    expect(fs.existsSync(path.join(tmpDir, ".claude", "CLAUDE.md"))).toBe(true);
  });

  it("includes project name and jira instance", async () => {
    await generateClaudeMd(tmpDir, baseConfig);
    const content = fs.readFileSync(
      path.join(tmpDir, ".claude", "CLAUDE.md"),
      "utf8",
    );
    expect(content).toContain("myproject");
    expect(content).toContain("hi");
    expect(content).toContain("HI");
  });

  it("includes assignees", async () => {
    await generateClaudeMd(tmpDir, baseConfig);
    const content = fs.readFileSync(
      path.join(tmpDir, ".claude", "CLAUDE.md"),
      "utf8",
    );
    expect(content).toContain("alice");
    expect(content).toContain("bob");
  });

  it("detects TypeScript stack from tsconfig.json", async () => {
    fs.writeFileSync(path.join(tmpDir, "tsconfig.json"), "{}");
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ dependencies: {} }),
    );
    await generateClaudeMd(tmpDir, baseConfig);
    const content = fs.readFileSync(
      path.join(tmpDir, ".claude", "CLAUDE.md"),
      "utf8",
    );
    expect(content).toContain("TypeScript");
  });

  it("detects Next.js from package.json", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ dependencies: { next: "14.0.0" } }),
    );
    await generateClaudeMd(tmpDir, baseConfig);
    const content = fs.readFileSync(
      path.join(tmpDir, ".claude", "CLAUDE.md"),
      "utf8",
    );
    expect(content).toContain("Next.js");
  });

  it("detects Python from requirements.txt", async () => {
    fs.writeFileSync(path.join(tmpDir, "requirements.txt"), "fastapi");
    await generateClaudeMd(tmpDir, baseConfig);
    const content = fs.readFileSync(
      path.join(tmpDir, ".claude", "CLAUDE.md"),
      "utf8",
    );
    expect(content).toContain("Python");
  });

  it("detects Go from go.mod", async () => {
    fs.writeFileSync(path.join(tmpDir, "go.mod"), "module myapp");
    await generateClaudeMd(tmpDir, baseConfig);
    const content = fs.readFileSync(
      path.join(tmpDir, ".claude", "CLAUDE.md"),
      "utf8",
    );
    expect(content).toContain("Go");
  });

  it("includes MCP tool list", async () => {
    await generateClaudeMd(tmpDir, baseConfig);
    const content = fs.readFileSync(
      path.join(tmpDir, ".claude", "CLAUDE.md"),
      "utf8",
    );
    expect(content).toContain("jira_get_tasks");
    expect(content).toContain("jira_get_ticket");
  });

  it("includes github owner and repo", async () => {
    await generateClaudeMd(tmpDir, baseConfig);
    const content = fs.readFileSync(
      path.join(tmpDir, ".claude", "CLAUDE.md"),
      "utf8",
    );
    expect(content).toContain("org");
    expect(content).toContain("repo");
  });

  it("detects NestJS from package.json", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ dependencies: { "@nestjs/core": "10.0.0" } }),
    );
    await generateClaudeMd(tmpDir, baseConfig);
    const content = fs.readFileSync(
      path.join(tmpDir, ".claude", "CLAUDE.md"),
      "utf8",
    );
    expect(content).toContain("NestJS");
  });

  it("detects Express from package.json", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ dependencies: { express: "4.0.0" } }),
    );
    await generateClaudeMd(tmpDir, baseConfig);
    const content = fs.readFileSync(
      path.join(tmpDir, ".claude", "CLAUDE.md"),
      "utf8",
    );
    expect(content).toContain("Express");
  });

  it("detects Prisma ORM from package.json", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({
        dependencies: { "@prisma/client": "5.0.0", prisma: "5.0.0" },
      }),
    );
    await generateClaudeMd(tmpDir, baseConfig);
    const content = fs.readFileSync(
      path.join(tmpDir, ".claude", "CLAUDE.md"),
      "utf8",
    );
    expect(content).toContain("Prisma");
  });

  it("detects TypeORM from package.json", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ dependencies: { typeorm: "0.3.0" } }),
    );
    await generateClaudeMd(tmpDir, baseConfig);
    const content = fs.readFileSync(
      path.join(tmpDir, ".claude", "CLAUDE.md"),
      "utf8",
    );
    expect(content).toContain("TypeORM");
  });

  it("detects Rust from Cargo.toml", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "Cargo.toml"),
      "[package]\nname = 'app'",
    );
    await generateClaudeMd(tmpDir, baseConfig);
    const content = fs.readFileSync(
      path.join(tmpDir, ".claude", "CLAUDE.md"),
      "utf8",
    );
    expect(content).toContain("Rust");
  });

  it("detects pyproject.toml as Python", async () => {
    fs.writeFileSync(path.join(tmpDir, "pyproject.toml"), "[tool.poetry]");
    await generateClaudeMd(tmpDir, baseConfig);
    const content = fs.readFileSync(
      path.join(tmpDir, ".claude", "CLAUDE.md"),
      "utf8",
    );
    expect(content).toContain("Python");
  });

  it("shows auto-detection fallback when no stack detected", async () => {
    await generateClaudeMd(tmpDir, baseConfig);
    const content = fs.readFileSync(
      path.join(tmpDir, ".claude", "CLAUDE.md"),
      "utf8",
    );
    expect(content).toContain("Auto-detection");
  });

  it("uses 'main' fallback when defaultBranch is undefined", async () => {
    const configNoBranch = {
      ...baseConfig,
      github: { ...baseConfig.github, defaultBranch: undefined },
    } as unknown as typeof baseConfig;
    await generateClaudeMd(tmpDir, configNoBranch);
    const content = fs.readFileSync(
      path.join(tmpDir, ".claude", "CLAUDE.md"),
      "utf8",
    );
    expect(content).toContain("main");
  });

  it("ignores corrupted package.json in detectStack", async () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), "NOT VALID JSON");
    // Should not throw — catch block in detectStack silently ignores parse errors
    await expect(generateClaudeMd(tmpDir, baseConfig)).resolves.not.toThrow();
    const content = fs.readFileSync(
      path.join(tmpDir, ".claude", "CLAUDE.md"),
      "utf8",
    );
    expect(content).toContain("Auto-detection");
  });
});

// ── writeMcpJson ──────────────────────────────────────────────────────────────

describe("writeMcpJson", () => {
  it("creates .claude/.mcp.json", async () => {
    await writeMcpJson(tmpDir, baseConfig, "hi");
    expect(fs.existsSync(path.join(tmpDir, ".claude", ".mcp.json"))).toBe(true);
  });

  it("writes valid JSON with mcpServers", async () => {
    await writeMcpJson(tmpDir, baseConfig, "hi");
    const raw = fs.readFileSync(
      path.join(tmpDir, ".claude", ".mcp.json"),
      "utf8",
    );
    const parsed = JSON.parse(raw) as {
      mcpServers: Record<string, unknown>;
    };
    expect(parsed.mcpServers).toBeDefined();
    expect(parsed.mcpServers["jira"]).toBeDefined();
  });

  it("uppercases instance name in env keys", async () => {
    await writeMcpJson(tmpDir, baseConfig, "myinstance");
    const raw = fs.readFileSync(
      path.join(tmpDir, ".claude", ".mcp.json"),
      "utf8",
    );
    expect(raw).toContain("JIRA_MYINSTANCE_URL");
    expect(raw).toContain("JIRA_MYINSTANCE_TOKEN");
  });

  it("command is jiraACP-mcp", async () => {
    await writeMcpJson(tmpDir, baseConfig, "hi");
    const parsed = JSON.parse(
      fs.readFileSync(path.join(tmpDir, ".claude", ".mcp.json"), "utf8"),
    ) as { mcpServers: { jira: { command: string } } };
    expect(parsed.mcpServers.jira.command).toBe("jiraACP-mcp");
  });
});
