import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { acquireLock, readLockData } from "../utils/lock.js";

let tmpDir: string;
let lockPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jira-lock-test-"));
  lockPath = path.join(tmpDir, "test.lock");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("acquireLock", () => {
  it("creates lock file with pid and stage", async () => {
    const lock = await acquireLock(lockPath);
    const data = readLockData(lockPath);
    expect(data).not.toBeNull();
    expect(data!.pid).toBe(process.pid);
    expect(data!.stage).toBe("init");
    lock.release();
  });

  it("accepts custom stage", async () => {
    const lock = await acquireLock(lockPath, "code");
    expect(readLockData(lockPath)!.stage).toBe("code");
    lock.release();
  });

  it("releases lock file on release()", async () => {
    const lock = await acquireLock(lockPath);
    lock.release();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("throws if lock held by live process", async () => {
    const lock = await acquireLock(lockPath);
    await expect(acquireLock(lockPath)).rejects.toThrow(
      /already running \(PID \d+/,
    );
    lock.release();
  });

  it("steals lock from dead process", async () => {
    // Write a lock with PID 999999999 (definitely dead)
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        pid: 999999999,
        startedAt: new Date().toISOString(),
        stage: "code",
      }),
    );
    const lock = await acquireLock(lockPath);
    expect(readLockData(lockPath)!.pid).toBe(process.pid);
    lock.release();
  });

  it("creates parent directories if missing", async () => {
    const nested = path.join(tmpDir, "a", "b", "c.lock");
    const lock = await acquireLock(nested);
    expect(fs.existsSync(nested)).toBe(true);
    lock.release();
  });

  it("lock is re-acquirable after release", async () => {
    const lock1 = await acquireLock(lockPath);
    lock1.release();
    const lock2 = await acquireLock(lockPath);
    expect(readLockData(lockPath)!.pid).toBe(process.pid);
    lock2.release();
  });

  it("throws non-EEXIST errors from writeFileSync", async () => {
    // Spy on writeFileSync to throw a non-EEXIST error (EROFS = read-only fs)
    const erofs = Object.assign(new Error("EROFS"), { code: "EROFS" });
    const writeSpy = vi
      .spyOn(fs, "writeFileSync")
      .mockImplementationOnce(() => {
        throw erofs;
      });
    await expect(acquireLock(lockPath)).rejects.toThrow("EROFS");
    writeSpy.mockRestore();
  });

  it("SIGINT handler calls cleanup and exits", async () => {
    const lock = await acquireLock(lockPath);
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => {}) as (code?: number) => never);
    process.emit("SIGINT", "SIGINT");
    expect(fs.existsSync(lockPath)).toBe(false);
    exitSpy.mockRestore();
    lock.release();
  });

  it("SIGTERM handler calls cleanup and exits", async () => {
    const lock = await acquireLock(lockPath);
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => {}) as (code?: number) => never);
    process.emit("SIGTERM", "SIGTERM");
    expect(fs.existsSync(lockPath)).toBe(false);
    exitSpy.mockRestore();
    lock.release();
  });
});

describe("readLockData", () => {
  it("returns null for non-existent file", () => {
    expect(readLockData("/nonexistent/path.lock")).toBeNull();
  });

  it("returns null for invalid JSON", () => {
    fs.writeFileSync(lockPath, "not json");
    expect(readLockData(lockPath)).toBeNull();
  });

  it("returns parsed data for valid lock file", () => {
    const data = {
      pid: 1234,
      startedAt: "2026-01-01T00:00:00Z",
      stage: "fetch",
    };
    fs.writeFileSync(lockPath, JSON.stringify(data));
    expect(readLockData(lockPath)).toEqual(data);
  });
});
