import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  writeTicketContext,
  readTicketContext,
  appendClarifications,
  writeReviewFeedback,
  getContextFilesForStage,
} from "../memory/context-builder.js";

let tmpDir: string;
let memoryDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jira-ctx-test-"));
  memoryDir = path.join(tmpDir, "memory");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const baseTicket = {
  key: "HI-100",
  summary: "Test ticket",
  description: "Some description",
  acceptanceCriteria: "AC here",
  priority: "High",
};

describe("writeTicketContext", () => {
  it("creates memoryDir and writes ticket-context.md", () => {
    writeTicketContext(memoryDir, baseTicket);
    const file = path.join(memoryDir, "ticket-context.md");
    expect(fs.existsSync(file)).toBe(true);
  });

  it("includes ticket key and summary in file", () => {
    writeTicketContext(memoryDir, baseTicket);
    const content = fs.readFileSync(
      path.join(memoryDir, "ticket-context.md"),
      "utf8",
    );
    expect(content).toContain("HI-100");
    expect(content).toContain("Test ticket");
  });

  it("includes description and acceptance criteria", () => {
    writeTicketContext(memoryDir, baseTicket);
    const content = fs.readFileSync(
      path.join(memoryDir, "ticket-context.md"),
      "utf8",
    );
    expect(content).toContain("Some description");
    expect(content).toContain("AC here");
  });

  it("shows (none) when description is empty", () => {
    writeTicketContext(memoryDir, { ...baseTicket, description: "" });
    const content = fs.readFileSync(
      path.join(memoryDir, "ticket-context.md"),
      "utf8",
    );
    expect(content).toContain("(none)");
  });

  it("shows (none) when acceptanceCriteria is empty", () => {
    writeTicketContext(memoryDir, { ...baseTicket, acceptanceCriteria: "" });
    const content = fs.readFileSync(
      path.join(memoryDir, "ticket-context.md"),
      "utf8",
    );
    expect(content).toContain("(none)");
  });

  it("includes clarifications section when provided", () => {
    writeTicketContext(memoryDir, {
      ...baseTicket,
      clarifications: "Use JWT auth",
    });
    const content = fs.readFileSync(
      path.join(memoryDir, "ticket-context.md"),
      "utf8",
    );
    expect(content).toContain("Clarifications");
    expect(content).toContain("Use JWT auth");
  });
});

describe("readTicketContext", () => {
  it("returns empty string when file does not exist", () => {
    expect(readTicketContext(memoryDir)).toBe("");
  });

  it("returns file content when it exists", () => {
    writeTicketContext(memoryDir, baseTicket);
    const content = readTicketContext(memoryDir);
    expect(content).toContain("HI-100");
  });
});

describe("appendClarifications", () => {
  it("appends clarifications to existing file", () => {
    writeTicketContext(memoryDir, baseTicket);
    appendClarifications(memoryDir, "Team says: use OAuth");
    const content = fs.readFileSync(
      path.join(memoryDir, "ticket-context.md"),
      "utf8",
    );
    expect(content).toContain("Team says: use OAuth");
  });

  it("does nothing when file does not exist", () => {
    expect(() => appendClarifications(memoryDir, "some answers")).not.toThrow();
    expect(fs.existsSync(path.join(memoryDir, "ticket-context.md"))).toBe(
      false,
    );
  });
});

describe("writeReviewFeedback", () => {
  it("creates review-feedback.md", () => {
    fs.mkdirSync(memoryDir, { recursive: true });
    writeReviewFeedback(memoryDir, {
      prNumber: 42,
      issues: [{ severity: "major", message: "Missing tests" }],
      autoResolved: false,
    });
    expect(fs.existsSync(path.join(memoryDir, "review-feedback.md"))).toBe(
      true,
    );
  });

  it("includes PR number and issue counts", () => {
    fs.mkdirSync(memoryDir, { recursive: true });
    writeReviewFeedback(memoryDir, {
      prNumber: 99,
      issues: [
        { severity: "major", message: "No types" },
        { severity: "minor", message: "Formatting" },
      ],
      autoResolved: true,
    });
    const content = fs.readFileSync(
      path.join(memoryDir, "review-feedback.md"),
      "utf8",
    );
    expect(content).toContain("PR: #99");
    expect(content).toContain("Major issues: 1");
    expect(content).toContain("Minor issues: 1");
    expect(content).toContain("Auto-resolved: true");
  });

  it("lists each issue in output", () => {
    fs.mkdirSync(memoryDir, { recursive: true });
    writeReviewFeedback(memoryDir, {
      prNumber: 1,
      issues: [{ severity: "minor", message: "Typo in comment" }],
      autoResolved: false,
    });
    const content = fs.readFileSync(
      path.join(memoryDir, "review-feedback.md"),
      "utf8",
    );
    expect(content).toContain("[MINOR]");
    expect(content).toContain("Typo in comment");
  });
});

describe("getContextFilesForStage", () => {
  it("returns empty array when no files exist", () => {
    const files = getContextFilesForStage(tmpDir, memoryDir, "fetch");
    expect(files).toEqual([]);
  });

  it("includes CLAUDE.md when it exists", () => {
    const claudeDir = path.join(tmpDir, ".claude");
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, "CLAUDE.md"), "# CLAUDE");
    const files = getContextFilesForStage(tmpDir, memoryDir, "fetch");
    expect(files.some((f) => f.endsWith("CLAUDE.md"))).toBe(true);
  });

  it("includes ticket-context.md for 'code' stage", () => {
    writeTicketContext(memoryDir, baseTicket);
    const files = getContextFilesForStage(tmpDir, memoryDir, "code");
    expect(files.some((f) => f.endsWith("ticket-context.md"))).toBe(true);
  });

  it("does NOT include ticket-context.md for 'fetch' stage", () => {
    writeTicketContext(memoryDir, baseTicket);
    const files = getContextFilesForStage(tmpDir, memoryDir, "fetch");
    expect(files.some((f) => f.endsWith("ticket-context.md"))).toBe(false);
  });

  it("includes review-feedback.md for 'test' stage", () => {
    fs.mkdirSync(memoryDir, { recursive: true });
    writeReviewFeedback(memoryDir, {
      prNumber: 1,
      issues: [],
      autoResolved: false,
    });
    const files = getContextFilesForStage(tmpDir, memoryDir, "test");
    expect(files.some((f) => f.endsWith("review-feedback.md"))).toBe(true);
  });

  it("does NOT include review-feedback.md for 'code' stage", () => {
    fs.mkdirSync(memoryDir, { recursive: true });
    writeReviewFeedback(memoryDir, {
      prNumber: 1,
      issues: [],
      autoResolved: false,
    });
    const files = getContextFilesForStage(tmpDir, memoryDir, "code");
    expect(files.some((f) => f.endsWith("review-feedback.md"))).toBe(false);
  });
});
