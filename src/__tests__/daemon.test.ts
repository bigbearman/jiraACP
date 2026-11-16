import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Mock child_process spawn at the module level (ESM requires vi.mock, not vi.spyOn)
const mockSpawn = vi.fn();
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: mockSpawn };
});

let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "jira-daemon-test-"));
  vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
  mockSpawn.mockReset();
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  vi.resetModules();
});

describe("getStatus", () => {
  it("returns not running when PID file contains non-numeric content", async () => {
    const { getStatus, getPidFile } = await import("../utils/daemon.js");
    const pidFile = getPidFile();
    fs.mkdirSync(path.dirname(pidFile), { recursive: true });
    fs.writeFileSync(pidFile, "not-a-pid"); // parseInt → NaN → readPid returns null
    const result = getStatus();
    expect(result.running).toBe(false);
    fs.unlinkSync(pidFile);
  });

  it("returns not running when no PID file", async () => {
    const { getStatus } = await import("../utils/daemon.js");
    expect(getStatus()).toEqual({ running: false });
  });

  it("returns not running and removes stale PID file for dead process", async () => {
    const { getStatus } = await import("../utils/daemon.js");
    const pidDir = path.join(tmpHome, ".jira-acp");
    fs.mkdirSync(pidDir, { recursive: true });
    fs.writeFileSync(path.join(pidDir, "jira-acp.pid"), "999999999");

    const result = getStatus();
    expect(result.running).toBe(false);
    expect(fs.existsSync(path.join(pidDir, "jira-acp.pid"))).toBe(false);
  });

  it("returns running for current process PID", async () => {
    const { getStatus, getPidFile } = await import("../utils/daemon.js");
    const pidFile = getPidFile();
    fs.mkdirSync(path.dirname(pidFile), { recursive: true });
    fs.writeFileSync(pidFile, String(process.pid));

    const result = getStatus();
    expect(result.running).toBe(true);
    expect(result.pid).toBe(process.pid);

    fs.unlinkSync(pidFile);
  });
});

describe("getPidFile / getLogFile", () => {
  it("PID file is under ~/.jira-acp/", async () => {
    const { getPidFile } = await import("../utils/daemon.js");
    expect(getPidFile()).toContain(".jira-acp");
    expect(getPidFile()).toContain("jira-acp.pid");
  });

  it("log file is under ~/.jira-acp/logs/", async () => {
    const { getLogFile } = await import("../utils/daemon.js");
    expect(getLogFile()).toContain(".jira-acp");
    expect(getLogFile()).toContain("logs");
    expect(getLogFile()).toContain("jira-acp.log");
  });
});

describe("startDaemon", () => {
  it("returns error if already running", async () => {
    const { startDaemon, getPidFile } = await import("../utils/daemon.js");
    const pidFile = getPidFile();
    fs.mkdirSync(path.dirname(pidFile), { recursive: true });
    fs.writeFileSync(pidFile, String(process.pid));

    const result = startDaemon(3110);
    expect("error" in result).toBe(true);
    expect((result as { error: string }).error).toMatch(/Already running/);

    fs.unlinkSync(pidFile);
  });

  it("spawns a detached child and writes PID file", async () => {
    const fakeChild = { pid: 99999, unref: vi.fn() };
    mockSpawn.mockReturnValue(fakeChild);

    const { startDaemon, getPidFile } = await import("../utils/daemon.js");
    const result = startDaemon(3200);

    expect(mockSpawn).toHaveBeenCalled();
    expect("pid" in result).toBe(true);
    expect((result as { pid: number }).pid).toBe(99999);

    const pidFile = getPidFile();
    expect(fs.existsSync(pidFile)).toBe(true);
    expect(fs.readFileSync(pidFile, "utf8")).toBe("99999");
  });

  it("returns error when child.pid is falsy", async () => {
    mockSpawn.mockReturnValue({ pid: undefined, unref: vi.fn() });

    const { startDaemon } = await import("../utils/daemon.js");
    const result = startDaemon(3300);

    expect("error" in result).toBe(true);
    expect((result as { error: string }).error).toMatch(/Failed to spawn/);
  });
});

describe("stopDaemon", () => {
  it("returns not running when no PID file", async () => {
    const { stopDaemon } = await import("../utils/daemon.js");
    const result = await stopDaemon();
    expect(result.stopped).toBe(false);
    expect(result.error).toMatch(/Not running/);
  });

  it("removes stale PID and returns not running", async () => {
    const { stopDaemon, getPidFile } = await import("../utils/daemon.js");
    const pidFile = getPidFile();
    fs.mkdirSync(path.dirname(pidFile), { recursive: true });
    fs.writeFileSync(pidFile, "999999999"); // dead process

    const result = await stopDaemon();
    expect(result.stopped).toBe(false);
    expect(result.error).toMatch(/stale PID/);
    expect(fs.existsSync(pidFile)).toBe(false);
  });

  it("sends SIGKILL when process survives SIGTERM after timeout", async () => {
    vi.useFakeTimers();
    const { stopDaemon, getPidFile } = await import("../utils/daemon.js");
    const pidFile = getPidFile();
    fs.mkdirSync(path.dirname(pidFile), { recursive: true });
    fs.writeFileSync(pidFile, String(process.pid));

    // Mock: process never dies — signal 0 always says alive
    const killSpy = vi
      .spyOn(process, "kill")
      .mockReturnValue(true as unknown as never);

    const stopPromise = stopDaemon();
    // Advance past 50 × 100ms = 5000ms to exhaust the wait loop
    await vi.advanceTimersByTimeAsync(5100);
    const result = await stopPromise;

    expect(result.stopped).toBe(true);
    expect(killSpy).toHaveBeenCalledWith(process.pid, "SIGKILL");
    killSpy.mockRestore();
    vi.useRealTimers();
  });

  it("sends SIGTERM and returns stopped when process dies after signal", async () => {
    const { stopDaemon, getPidFile } = await import("../utils/daemon.js");
    const pidFile = getPidFile();
    fs.mkdirSync(path.dirname(pidFile), { recursive: true });
    fs.writeFileSync(pidFile, String(process.pid));

    // Mock process.kill: SIGTERM does nothing visible; signal 0 throws after first SIGTERM
    let sigtermSent = false;
    const killSpy = vi.spyOn(process, "kill").mockImplementation((pid, sig) => {
      if (sig === "SIGTERM") {
        sigtermSent = true;
      } else if (sig === 0 && sigtermSent) {
        // Simulate: process no longer alive
        throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      }
      return true;
    });

    const result = await stopDaemon();
    expect(result.stopped).toBe(true);
    expect(result.pid).toBe(process.pid);
    killSpy.mockRestore();
  });
});
