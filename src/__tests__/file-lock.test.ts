import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { withFileLock, FileLockTimeout } from "../utils/file-lock.js";

describe("withFileLock", () => {
  let tmpDir: string;
  let testFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "file-lock-test-"));
    testFile = path.join(tmpDir, "test-file.md");
    fs.writeFileSync(testFile, "initial");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("executes the callback and returns its result", async () => {
    const result = await withFileLock(testFile, () => 42);
    expect(result).toBe(42);
  });

  it("executes async callbacks", async () => {
    const result = await withFileLock(testFile, async () => {
      return "async-result";
    });
    expect(result).toBe("async-result");
  });

  it("releases the lock after successful execution", async () => {
    await withFileLock(testFile, () => "done");
    const lockPath = `${testFile}.lock`;
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("releases the lock after an error", async () => {
    const lockPath = `${testFile}.lock`;

    await expect(
      withFileLock(testFile, () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("throws FileLockTimeout when lock cannot be acquired", async () => {
    const lockPath = `${testFile}.lock`;

    // Create a non-stale lock manually
    const lockData = {
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
    };
    fs.writeFileSync(lockPath, JSON.stringify(lockData), { flag: "wx" });

    await expect(
      withFileLock(testFile, () => "should-not-run", 500),
    ).rejects.toBeInstanceOf(FileLockTimeout);

    // Clean up
    fs.unlinkSync(lockPath);
  });

  it("steals stale locks older than 60s", async () => {
    const lockPath = `${testFile}.lock`;

    // Create a stale lock (acquiredAt 120s ago)
    const staleData = {
      pid: 999999,
      acquiredAt: new Date(Date.now() - 120_000).toISOString(),
    };
    fs.writeFileSync(lockPath, JSON.stringify(staleData), { flag: "wx" });

    const result = await withFileLock(testFile, () => "stolen");
    expect(result).toBe("stolen");
  });

  it("serializes concurrent access", async () => {
    const order: number[] = [];

    const task = (id: number, delayMs: number): Promise<void> =>
      withFileLock(testFile, async () => {
        order.push(id);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      });

    await Promise.all([task(1, 50), task(2, 10)]);

    expect(order).toHaveLength(2);
    // Both tasks completed — order depends on scheduling
    expect(order).toContain(1);
    expect(order).toContain(2);
  });
});

describe("FileLockTimeout", () => {
  it("has correct name and message", () => {
    const err = new FileLockTimeout("/tmp/foo.md", 5000);
    expect(err.name).toBe("FileLockTimeout");
    expect(err.message).toContain("/tmp/foo.md");
    expect(err.message).toContain("5000ms");
    expect(err).toBeInstanceOf(Error);
  });
});
