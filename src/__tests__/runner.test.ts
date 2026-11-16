import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Mock spawnSafe so we never actually call claude CLI
const mockSpawnSafe = vi.fn();
vi.mock("../utils/process.js", () => ({
  spawnSafe: mockSpawnSafe,
  buildMinimalEnv: (extra?: Record<string, string>) => ({
    PATH: "/usr/bin",
    ...extra,
  }),
}));

let tmpDir: string;

const cliJson = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "agent output",
    total_cost_usd: 0.002,
    modelUsage: {
      "claude-haiku-4-5-20251001": {
        inputTokens: 1000,
        outputTokens: 200,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        costUSD: 0.002,
      },
    },
    ...overrides,
  });

beforeEach(() => {
  mockSpawnSafe.mockClear();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "runner-test-"));
  mockSpawnSafe.mockResolvedValue({
    stdout: cliJson(),
    stderr: "",
    exitCode: 0,
  });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.resetModules();
});

describe("buildClaudeArgs — contextFiles", () => {
  it("does NOT use --context flag (unsupported by claude CLI)", async () => {
    const ctxFile = path.join(tmpDir, "ticket-context.md");
    fs.writeFileSync(ctxFile, "## Summary\nFix login bug");

    const { runAgent } = await import("../pipeline/runner.js");
    await runAgent({
      prompt: "do the task",
      workdir: tmpDir,
      model: "haiku",
      contextFiles: [ctxFile],
    });

    const [, args] = mockSpawnSafe.mock.calls[0] as [string, string[]];
    expect(args).not.toContain("--context");
  });

  it("uses --add-dir for directories containing context files", async () => {
    const ctxFile = path.join(tmpDir, "ticket-context.md");
    fs.writeFileSync(ctxFile, "## Summary\nFix login bug");

    const { runAgent } = await import("../pipeline/runner.js");
    await runAgent({
      prompt: "do the task",
      workdir: tmpDir,
      model: "haiku",
      contextFiles: [ctxFile],
    });

    const [, args] = mockSpawnSafe.mock.calls[0] as [string, string[]];
    const addDirIdx = args.indexOf("--add-dir");
    expect(addDirIdx).toBeGreaterThanOrEqual(0);
    expect(args[addDirIdx + 1]).toBe(tmpDir);
  });

  it("deduplicates --add-dir when multiple files share the same directory", async () => {
    const file1 = path.join(tmpDir, "ticket-context.md");
    const file2 = path.join(tmpDir, "review-feedback.md");
    fs.writeFileSync(file1, "context 1");
    fs.writeFileSync(file2, "context 2");

    const { runAgent } = await import("../pipeline/runner.js");
    await runAgent({
      prompt: "do the task",
      workdir: tmpDir,
      model: "haiku",
      contextFiles: [file1, file2],
    });

    const [, args] = mockSpawnSafe.mock.calls[0] as [string, string[]];
    const addDirOccurrences = args.filter((a) => a === "--add-dir").length;
    expect(addDirOccurrences).toBe(1); // deduplicated
  });

  it("mentions context file paths in the prompt so Claude knows to read them", async () => {
    const ctxFile = path.join(tmpDir, "ticket-context.md");
    fs.writeFileSync(ctxFile, "## Summary\nFix login bug");

    const { runAgent } = await import("../pipeline/runner.js");
    await runAgent({
      prompt: "do the task",
      workdir: tmpDir,
      model: "haiku",
      contextFiles: [ctxFile],
    });

    const [, args] = mockSpawnSafe.mock.calls[0] as [string, string[]];
    const promptArg = args[args.length - 1];
    expect(promptArg).toContain(ctxFile);
  });

  it("works fine with no context files", async () => {
    const { runAgent } = await import("../pipeline/runner.js");
    await runAgent({ prompt: "do the task", workdir: tmpDir, model: "haiku" });

    const [, args] = mockSpawnSafe.mock.calls[0] as [string, string[]];
    expect(args).not.toContain("--add-dir");
    expect(args).not.toContain("--context");
  });

  it("skips non-existent context files", async () => {
    const { runAgent } = await import("../pipeline/runner.js");
    await runAgent({
      prompt: "do the task",
      workdir: tmpDir,
      model: "haiku",
      contextFiles: ["/nonexistent/file.md"],
    });

    const [, args] = mockSpawnSafe.mock.calls[0] as [string, string[]];
    expect(args).not.toContain("--add-dir");
  });
});

describe("buildClaudeArgs — model and base flags", () => {
  it("passes --model with correct ID for haiku", async () => {
    const { runAgent } = await import("../pipeline/runner.js");
    await runAgent({ prompt: "hello", workdir: tmpDir, model: "haiku" });

    const [, args] = mockSpawnSafe.mock.calls[0] as [string, string[]];
    expect(args).toContain("--model");
    expect(args[args.indexOf("--model") + 1]).toBe("claude-haiku-4-5-20251001");
  });

  it("passes --print and --output-format json", async () => {
    const { runAgent } = await import("../pipeline/runner.js");
    await runAgent({ prompt: "hello", workdir: tmpDir, model: "sonnet" });

    const [, args] = mockSpawnSafe.mock.calls[0] as [string, string[]];
    expect(args).toContain("--print");
    expect(args).toContain("--output-format");
    expect(args[args.indexOf("--output-format") + 1]).toBe("json");
  });

  it.each([
    ["sonnet", "claude-sonnet-4-6"],
    ["opus", "claude-opus-4-6"],
  ] as const)("passes the model ID for %s", async (model, id) => {
    const { runAgent } = await import("../pipeline/runner.js");
    await runAgent({ prompt: "hello", workdir: tmpDir, model });

    const [, args] = mockSpawnSafe.mock.calls[0] as [string, string[]];
    expect(args[args.indexOf("--model") + 1]).toBe(id);
  });
});

describe("runAgent — error handling", () => {
  it("throws when exitCode is non-zero", async () => {
    mockSpawnSafe.mockResolvedValueOnce({
      stdout: "",
      stderr: "some error",
      exitCode: 1,
    });
    const { runAgent } = await import("../pipeline/runner.js");
    await expect(
      runAgent({ prompt: "hello", workdir: tmpDir, model: "haiku" }),
    ).rejects.toThrow(/Agent exited with code 1/);
  });

  it("returns the trimmed result field on success", async () => {
    mockSpawnSafe.mockResolvedValueOnce({
      stdout: cliJson({ result: "  result  \n" }),
      stderr: "",
      exitCode: 0,
    });
    const { runAgent } = await import("../pipeline/runner.js");
    const out = await runAgent({
      prompt: "hello",
      workdir: tmpDir,
      model: "haiku",
    });
    expect(out).toBe("result");
  });

  it("returns trimmed stdout when the CLI output is not JSON", async () => {
    mockSpawnSafe.mockResolvedValueOnce({
      stdout: "  plain text  \n",
      stderr: "",
      exitCode: 0,
    });
    const record = vi.fn();
    const { runAgent } = await import("../pipeline/runner.js");
    const out = await runAgent({
      prompt: "hello",
      workdir: tmpDir,
      model: "haiku",
      usage: { record },
    });
    expect(out).toBe("plain text");
    expect(record).not.toHaveBeenCalled();
  });

  it("throws when the CLI reports is_error", async () => {
    mockSpawnSafe.mockResolvedValueOnce({
      stdout: cliJson({ is_error: true, subtype: "error_max_turns" }),
      stderr: "",
      exitCode: 0,
    });
    const { runAgent } = await import("../pipeline/runner.js");
    await expect(
      runAgent({ prompt: "hello", workdir: tmpDir, model: "haiku" }),
    ).rejects.toThrow(/error_max_turns/);
  });
});

describe("runAgent — token usage", () => {
  it("records the CLI's per-model usage", async () => {
    const record = vi.fn();
    const { runAgent } = await import("../pipeline/runner.js");
    await runAgent({
      prompt: "hello",
      workdir: tmpDir,
      model: "haiku",
      usage: { record },
    });

    expect(record).toHaveBeenCalledOnce();
    expect(record.mock.calls[0][0]).toEqual({
      cliReportedCostUsd: 0.002,
      byModel: {
        "claude-haiku-4-5-20251001": {
          inputTokens: 1000,
          outputTokens: 200,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          cliCostUsd: 0.002,
        },
      },
    });
  });

  it("records usage even when the CLI exits non-zero", async () => {
    mockSpawnSafe.mockResolvedValueOnce({
      stdout: cliJson({ is_error: true, result: "auth failed" }),
      stderr: "",
      exitCode: 1,
    });
    const record = vi.fn();
    const { runAgent } = await import("../pipeline/runner.js");
    await expect(
      runAgent({
        prompt: "hello",
        workdir: tmpDir,
        model: "haiku",
        usage: { record },
      }),
    ).rejects.toThrow(/auth failed/);
    expect(record).toHaveBeenCalledOnce();
  });
});

describe("detectComplexity", () => {
  it("returns opus when 2+ complex keywords match", async () => {
    const { detectComplexity } = await import("../pipeline/runner.js");
    expect(detectComplexity("implement auth and payment flow")).toBe("opus");
  });

  it("returns sonnet when fewer than 2 keywords match", async () => {
    const { detectComplexity } = await import("../pipeline/runner.js");
    expect(detectComplexity("add a button to the UI")).toBe("sonnet");
  });

  it("keeps the given base model when the task is simple", async () => {
    const { detectComplexity } = await import("../pipeline/runner.js");
    expect(detectComplexity("add a button", "haiku")).toBe("haiku");
  });
});
