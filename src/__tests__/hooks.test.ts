import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Logger } from "pino";
import { runHook, HookError } from "../pipeline/hooks.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jira-hook-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
}

const ctx = { ticketKey: "HI-1", logger: makeLogger() };

describe("HookError", () => {
  it("has correct name and message", () => {
    const err = new HookError("beforePipeline", 1);
    expect(err.name).toBe("HookError");
    expect(err.message).toContain("beforePipeline");
    expect(err.message).toContain("1");
  });

  it("exposes hookName and exitCode", () => {
    const err = new HookError("afterDeploy", 127);
    expect(err.hookName).toBe("afterDeploy");
    expect(err.exitCode).toBe(127);
  });

  it("is instanceof Error", () => {
    expect(new HookError("afterPipeline", 2)).toBeInstanceOf(Error);
  });
});

describe("runHook", () => {
  it("no-ops when command is undefined", async () => {
    const logger = makeLogger();
    await expect(
      runHook("beforePipeline", undefined, { ticketKey: "HI-1", logger }),
    ).resolves.toBeUndefined();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("no-ops when command is empty string", async () => {
    const logger = makeLogger();
    await expect(
      runHook("beforePipeline", "   ", { ticketKey: "HI-1", logger }),
    ).resolves.toBeUndefined();
  });

  it("runs a successful command without throwing", async () => {
    const logger = makeLogger();
    await expect(
      runHook("beforeCode", "echo hello", { ticketKey: "HI-1", logger }),
    ).resolves.toBeUndefined();
    expect(logger.info).toHaveBeenCalled();
  });

  it("throws HookError when command exits non-zero", async () => {
    const logger = makeLogger();
    await expect(
      runHook("afterCode", "false", { ticketKey: "HI-1", logger }),
    ).rejects.toBeInstanceOf(HookError);
  });

  it("HookError carries hookName and exitCode", async () => {
    const logger = makeLogger();
    try {
      await runHook("afterDeploy", "false", { ticketKey: "HI-1", logger });
    } catch (err) {
      expect(err).toBeInstanceOf(HookError);
      expect((err as HookError).hookName).toBe("afterDeploy");
      expect((err as HookError).exitCode).not.toBe(0);
    }
  });

  it("passes JIRA_ACP_TICKET env to hook process", async () => {
    const logger = makeLogger();
    // Write a script that outputs the env var to a file, then verify the file
    const outFile = path.join(tmpDir, "ticket.txt");
    const script = path.join(tmpDir, "check-env.sh");
    fs.writeFileSync(
      script,
      `#!/bin/sh\necho "$JIRA_ACP_TICKET" > "${outFile}"\n`,
    );
    fs.chmodSync(script, 0o755);

    await runHook("beforePipeline", script, { ticketKey: "HI-99", logger });

    const written = fs.readFileSync(outFile, "utf8").trim();
    expect(written).toBe("HI-99");
  });
});
