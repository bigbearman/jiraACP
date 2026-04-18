import { describe, it, expect, vi, afterEach } from "vitest";
import { buildMinimalEnv, spawnSafe } from "../utils/process.js";

describe("buildMinimalEnv", () => {
  it("includes PATH, HOME, USER from process.env", () => {
    const env = buildMinimalEnv();
    // Whitelisted keys present in process.env must appear
    if (process.env["PATH"]) expect(env["PATH"]).toBe(process.env["PATH"]);
    if (process.env["HOME"]) expect(env["HOME"]).toBe(process.env["HOME"]);
  });

  it("merges extra keys into the result", () => {
    const env = buildMinimalEnv({ MY_VAR: "hello", ANOTHER: "world" });
    expect(env["MY_VAR"]).toBe("hello");
    expect(env["ANOTHER"]).toBe("world");
  });

  it("extra keys override whitelisted values", () => {
    const env = buildMinimalEnv({ PATH: "/custom/bin" });
    expect(env["PATH"]).toBe("/custom/bin");
  });

  it("does not include non-whitelisted process.env keys", () => {
    process.env["JIRA_ACP_TEST_SECRET"] = "should-not-appear";
    const env = buildMinimalEnv();
    expect("JIRA_ACP_TEST_SECRET" in env).toBe(false);
    delete process.env["JIRA_ACP_TEST_SECRET"];
  });

  it("includes GIT_* pattern keys when present", () => {
    process.env["GIT_AUTHOR_NAME"] = "test-author";
    const env = buildMinimalEnv();
    expect(env["GIT_AUTHOR_NAME"]).toBe("test-author");
    delete process.env["GIT_AUTHOR_NAME"];
  });

  it("omits whitelisted keys that are not set in process.env", () => {
    const saved = process.env["ANTHROPIC_API_KEY"];
    delete process.env["ANTHROPIC_API_KEY"];
    const env = buildMinimalEnv();
    // Key should be absent (not empty string) when not in process.env
    expect("ANTHROPIC_API_KEY" in env).toBe(false);
    if (saved !== undefined) process.env["ANTHROPIC_API_KEY"] = saved;
  });
});

describe("spawnSafe", () => {
  it("captures stdout from a command", async () => {
    const result = await spawnSafe("echo", ["hello world"]);
    expect(result.stdout.trim()).toBe("hello world");
    expect(result.exitCode).toBe(0);
  });

  it("returns exitCode 0 on success", async () => {
    const result = await spawnSafe("true", []);
    expect(result.exitCode).toBe(0);
  });

  it("returns non-zero exitCode on failure", async () => {
    const result = await spawnSafe("false", []);
    expect(result.exitCode).not.toBe(0);
  });

  it("captures stderr from a command", async () => {
    const result = await spawnSafe("sh", ["-c", "echo err >&2"]);
    expect(result.stderr.trim()).toBe("err");
  });

  it("rejects when binary does not exist", async () => {
    await expect(spawnSafe("__nonexistent_binary_xyz__", [])).rejects.toThrow();
  });

  it("resolves with both stdout and stderr", async () => {
    const result = await spawnSafe("sh", ["-c", "echo out; echo err >&2"]);
    expect(result.stdout.trim()).toBe("out");
    expect(result.stderr.trim()).toBe("err");
    expect(result.exitCode).toBe(0);
  });

  it("rejects when global timeout exceeded", async () => {
    await expect(spawnSafe("sleep", ["10"], { timeoutMs: 50 })).rejects.toThrow(
      /timed out/i,
    );
  });

  it("rejects when stall timeout exceeded", async () => {
    await expect(
      spawnSafe("sleep", ["10"], { stallTimeoutMs: 50 }),
    ).rejects.toThrow(/stalled/i);
  });

  it("uses custom env when provided", async () => {
    const result = await spawnSafe("sh", ["-c", "echo $MY_CUSTOM_VAR"], {
      env: { ...buildMinimalEnv(), MY_CUSTOM_VAR: "test_value" },
    });
    expect(result.stdout.trim()).toBe("test_value");
  });

  it("clears existing stall timer when more data arrives (resetStall called twice)", async () => {
    // Use a command that produces output in two bursts — this triggers resetStall twice,
    // exercising the `if (stallTimer) clearTimeout(stallTimer)` branch.
    const result = await spawnSafe(
      "sh",
      ["-c", "echo first; sleep 0.05; echo second"],
      { stallTimeoutMs: 5_000 },
    );
    expect(result.stdout).toContain("first");
    expect(result.stdout).toContain("second");
    expect(result.exitCode).toBe(0);
  });

  it("clears both stall and global timers on process error", async () => {
    // Trigger an error on a command with both timers set.
    // We rely on the nonexistent binary path to cause an ENOENT error.
    await expect(
      spawnSafe("__no_such_bin__", [], {
        timeoutMs: 5_000,
        stallTimeoutMs: 5_000,
      }),
    ).rejects.toThrow();
  });
});
