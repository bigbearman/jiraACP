import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StateManager } from "../pipeline/state.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jira-acp-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("StateManager — emit & current", () => {
  it("starts with empty initial state", () => {
    const sm = new StateManager(tmpDir);
    const s = sm.current;
    expect(s.isCompleted).toBe(false);
    expect(s.isAborted).toBe(false);
    expect(s.currentStage).toBeNull();
    expect(s.completedStages).toEqual([]);
  });

  it("tracks STARTED event", () => {
    const sm = new StateManager(tmpDir);
    sm.emit({ type: "STARTED", ticketKey: "HI-123" });
    expect(sm.current.ticketKey).toBe("HI-123");
    expect(sm.current.startedAt).toBeTruthy();
  });

  it("tracks STAGE_STARTED → current stage", () => {
    const sm = new StateManager(tmpDir);
    sm.emit({ type: "STARTED", ticketKey: "HI-123" });
    sm.emit({ type: "STAGE_STARTED", stage: "fetch" });
    expect(sm.current.currentStage).toBe("fetch");
  });

  it("tracks STAGE_COMPLETED → moves to completedStages", () => {
    const sm = new StateManager(tmpDir);
    sm.emit({ type: "STARTED", ticketKey: "HI-123" });
    sm.emit({ type: "STAGE_STARTED", stage: "fetch" });
    sm.emit({ type: "STAGE_COMPLETED", stage: "fetch", output: {} });
    expect(sm.current.currentStage).toBeNull();
    expect(sm.current.completedStages).toContain("fetch");
  });

  it("captures branchName and prNumber from STAGE_COMPLETED output", () => {
    const sm = new StateManager(tmpDir);
    sm.emit({ type: "STARTED", ticketKey: "HI-123" });
    sm.emit({ type: "STAGE_STARTED", stage: "git" });
    sm.emit({
      type: "STAGE_COMPLETED",
      stage: "git",
      output: { branchName: "feature/HI-123-fix", prNumber: 42 },
    });
    expect(sm.current.branchName).toBe("feature/HI-123-fix");
    expect(sm.current.prNumber).toBe(42);
  });

  it("tracks STAGE_FAILED", () => {
    const sm = new StateManager(tmpDir);
    sm.emit({ type: "STARTED", ticketKey: "HI-123" });
    sm.emit({ type: "STAGE_STARTED", stage: "code" });
    sm.emit({ type: "STAGE_FAILED", stage: "code", error: "timeout" });
    expect(sm.current.failedStage).toBe("code");
    expect(sm.current.currentStage).toBeNull();
  });

  it("tracks STAGE_SKIPPED", () => {
    const sm = new StateManager(tmpDir);
    sm.emit({ type: "STARTED", ticketKey: "HI-123" });
    sm.emit({
      type: "STAGE_SKIPPED",
      stage: "clarify",
      reason: "clear enough",
    });
    expect(sm.current.completedStages).toContain("clarify");
  });

  it("sets pendingClarification on CLARIFICATION_REQUESTED", () => {
    const sm = new StateManager(tmpDir);
    sm.emit({ type: "STARTED", ticketKey: "HI-123" });
    sm.emit({ type: "CLARIFICATION_REQUESTED", questions: ["What color?"] });
    expect(sm.current.pendingClarification).toBe(true);
  });

  it("clears pendingClarification on CLARIFICATION_RECEIVED", () => {
    const sm = new StateManager(tmpDir);
    sm.emit({ type: "STARTED", ticketKey: "HI-123" });
    sm.emit({ type: "CLARIFICATION_REQUESTED", questions: ["What color?"] });
    sm.emit({ type: "CLARIFICATION_RECEIVED", answers: "Blue" });
    expect(sm.current.pendingClarification).toBe(false);
  });

  it("sets pendingHumanApproval on HUMAN_APPROVAL_REQUESTED", () => {
    const sm = new StateManager(tmpDir);
    sm.emit({ type: "STARTED", ticketKey: "HI-123" });
    sm.emit({ type: "HUMAN_APPROVAL_REQUESTED", context: {} });
    expect(sm.current.pendingHumanApproval).toBe(true);
  });

  it("clears pendingHumanApproval on HUMAN_APPROVED", () => {
    const sm = new StateManager(tmpDir);
    sm.emit({ type: "STARTED", ticketKey: "HI-123" });
    sm.emit({ type: "HUMAN_APPROVAL_REQUESTED", context: {} });
    sm.emit({ type: "HUMAN_APPROVED" });
    expect(sm.current.pendingHumanApproval).toBe(false);
  });

  it("clears pendingHumanApproval on HUMAN_REJECTED", () => {
    const sm = new StateManager(tmpDir);
    sm.emit({ type: "STARTED", ticketKey: "HI-123" });
    sm.emit({ type: "HUMAN_APPROVAL_REQUESTED", context: {} });
    sm.emit({ type: "HUMAN_REJECTED", reason: "looks bad" });
    expect(sm.current.pendingHumanApproval).toBe(false);
  });

  it("marks isCompleted on PIPELINE_COMPLETED", () => {
    const sm = new StateManager(tmpDir);
    sm.emit({ type: "STARTED", ticketKey: "HI-123" });
    sm.emit({ type: "PIPELINE_COMPLETED" });
    expect(sm.current.isCompleted).toBe(true);
    expect(sm.current.currentStage).toBeNull();
  });

  it("marks isAborted with reason on PIPELINE_ABORTED", () => {
    const sm = new StateManager(tmpDir);
    sm.emit({ type: "STARTED", ticketKey: "HI-123" });
    sm.emit({ type: "PIPELINE_ABORTED", reason: "Cost limit exceeded" });
    expect(sm.current.isAborted).toBe(true);
    expect(sm.current.abortReason).toBe("Cost limit exceeded");
  });
});

describe("StateManager — persistence & crash recovery", () => {
  it("persists events to state.json (append-only)", () => {
    const sm = new StateManager(tmpDir);
    sm.emit({ type: "STARTED", ticketKey: "HI-123" });
    sm.emit({ type: "STAGE_STARTED", stage: "fetch" });

    const lines = fs
      .readFileSync(path.join(tmpDir, "state.json"), "utf8")
      .split("\n")
      .filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toMatchObject({ type: "STARTED" });
    expect(JSON.parse(lines[1])).toMatchObject({
      type: "STAGE_STARTED",
      stage: "fetch",
    });
  });

  it("replays events correctly after restart (crash recovery)", () => {
    // Simulate: process 1 writes events then crashes
    const sm1 = new StateManager(tmpDir);
    sm1.emit({ type: "STARTED", ticketKey: "HI-123" });
    sm1.emit({ type: "STAGE_STARTED", stage: "fetch" });
    sm1.emit({ type: "STAGE_COMPLETED", stage: "fetch", output: {} });
    sm1.emit({ type: "STAGE_STARTED", stage: "analyze" });
    // crash — never writes STAGE_COMPLETED for analyze

    // Process 2 resumes
    const sm2 = new StateManager(tmpDir);
    const state = sm2.current;
    expect(state.ticketKey).toBe("HI-123");
    expect(state.completedStages).toContain("fetch");
    expect(state.currentStage).toBe("analyze");
    expect(state.isCompleted).toBe(false);
  });

  it("each event has a timestamp", () => {
    const sm = new StateManager(tmpDir);
    sm.emit({ type: "STARTED", ticketKey: "HI-123" });
    const line = fs
      .readFileSync(path.join(tmpDir, "state.json"), "utf8")
      .split("\n")[0]!;
    const event = JSON.parse(line);
    expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("handles empty state file gracefully", () => {
    fs.writeFileSync(path.join(tmpDir, "state.json"), "");
    const sm = new StateManager(tmpDir);
    expect(sm.current.isCompleted).toBe(false);
  });

  it("accumulates multiple stages across full pipeline", () => {
    const stages = ["fetch", "analyze", "code", "git", "notify"] as const;
    const sm = new StateManager(tmpDir);
    sm.emit({ type: "STARTED", ticketKey: "HI-123" });
    for (const stage of stages) {
      sm.emit({ type: "STAGE_STARTED", stage });
      sm.emit({ type: "STAGE_COMPLETED", stage, output: {} });
    }
    sm.emit({ type: "PIPELINE_COMPLETED" });

    const state = sm.current;
    expect(state.isCompleted).toBe(true);
    expect(state.completedStages).toEqual(stages);
    expect(state.currentStage).toBeNull();
  });
});

describe("applyEvent default case", () => {
  it("returns unchanged state for unknown event type", () => {
    const sm = new StateManager(tmpDir);
    sm.emit({ type: "STARTED", ticketKey: "HI-1" });
    // Write a raw unknown event directly to the state file
    const statePath = path.join(tmpDir, "state.json");
    fs.appendFileSync(
      statePath,
      JSON.stringify({
        type: "UNKNOWN_EVENT_XYZ",
        timestamp: new Date().toISOString(),
      }) + "\n",
    );
    // Reload by creating a new StateManager on the same dir
    const sm2 = new StateManager(tmpDir);
    // State should be unchanged by the unknown event
    expect(sm2.current.ticketKey).toBe("HI-1");
    expect(sm2.current.isCompleted).toBe(false);
  });
});

describe("getRunDir / getLockPath / getMemoryDir", () => {
  beforeEach(() => {
    vi.spyOn(os, "homedir").mockReturnValue(tmpDir);
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("getRunDir returns path under runs dir", async () => {
    const { getRunDir } = await import("../pipeline/state.js");
    const result = getRunDir("myproject", "HI-1");
    expect(result).toContain("runs");
    expect(result).toContain("myproject");
    expect(result).toContain("HI-1");
  });

  it("getLockPath returns lock file path", async () => {
    const { getLockPath } = await import("../pipeline/state.js");
    const result = getLockPath("myproject", "HI-1");
    expect(result).toContain("HI-1.lock");
  });

  it("getMemoryDir returns memory subdir", async () => {
    const { getMemoryDir } = await import("../pipeline/state.js");
    const result = getMemoryDir("myproject", "HI-1");
    expect(result).toContain("memory");
    expect(result).toContain("HI-1");
  });
});
