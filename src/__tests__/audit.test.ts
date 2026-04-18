import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "jira-audit-test-"));
  vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  vi.resetModules();
});

async function getAuditFile(): Promise<string> {
  return path.join(tmpHome, ".jira-acp", "audit.log");
}

describe("writeAuditEntry", () => {
  it("creates audit.log file on first write", async () => {
    const { writeAuditEntry } = await import("../utils/audit.js");
    writeAuditEntry({
      project: "test",
      ticketKey: "HI-1",
      action: "JIRA_COMMENT_ADDED",
      detail: {},
    });
    const auditFile = await getAuditFile();
    expect(fs.existsSync(auditFile)).toBe(true);
  });

  it("writes a valid JSON line", async () => {
    const { writeAuditEntry } = await import("../utils/audit.js");
    writeAuditEntry({
      project: "myproj",
      ticketKey: "HI-42",
      action: "GITHUB_PR_CREATED",
      detail: { prNumber: 7 },
    });
    const auditFile = await getAuditFile();
    const line = fs.readFileSync(auditFile, "utf8").trim();
    const parsed = JSON.parse(line);
    expect(parsed.project).toBe("myproj");
    expect(parsed.ticketKey).toBe("HI-42");
    expect(parsed.action).toBe("GITHUB_PR_CREATED");
    expect(typeof parsed.timestamp).toBe("string");
  });

  it("redacts 'token' field in detail", async () => {
    const { writeAuditEntry } = await import("../utils/audit.js");
    writeAuditEntry({
      project: "p",
      ticketKey: "HI-1",
      action: "TELEGRAM_MESSAGE_SENT",
      detail: { token: "super-secret" },
    });
    const auditFile = await getAuditFile();
    const parsed = JSON.parse(fs.readFileSync(auditFile, "utf8").trim());
    expect(parsed.detail.token).toBe("<redacted>");
  });

  it("redacts 'botToken' field in detail", async () => {
    const { writeAuditEntry } = await import("../utils/audit.js");
    writeAuditEntry({
      project: "p",
      ticketKey: "HI-1",
      action: "TELEGRAM_MESSAGE_SENT",
      detail: { botToken: "123:ABC" },
    });
    const auditFile = await getAuditFile();
    const parsed = JSON.parse(fs.readFileSync(auditFile, "utf8").trim());
    expect(parsed.detail.botToken).toBe("<redacted>");
  });

  it("redacts 'secret' and 'password' fields", async () => {
    const { writeAuditEntry } = await import("../utils/audit.js");
    writeAuditEntry({
      project: "p",
      ticketKey: "HI-1",
      action: "JIRA_STATUS_CHANGED",
      detail: { secret: "shh", password: "1234" },
    });
    const auditFile = await getAuditFile();
    const parsed = JSON.parse(fs.readFileSync(auditFile, "utf8").trim());
    expect(parsed.detail.secret).toBe("<redacted>");
    expect(parsed.detail.password).toBe("<redacted>");
  });

  it("does NOT redact non-secret fields", async () => {
    const { writeAuditEntry } = await import("../utils/audit.js");
    writeAuditEntry({
      project: "p",
      ticketKey: "HI-1",
      action: "GITHUB_PR_MERGED",
      detail: { prNumber: 5, merged: true },
    });
    const auditFile = await getAuditFile();
    const parsed = JSON.parse(fs.readFileSync(auditFile, "utf8").trim());
    expect(parsed.detail.prNumber).toBe(5);
    expect(parsed.detail.merged).toBe(true);
  });

  it("appends multiple entries as separate lines", async () => {
    const { writeAuditEntry } = await import("../utils/audit.js");
    writeAuditEntry({
      project: "p",
      ticketKey: "HI-1",
      action: "JIRA_COMMENT_ADDED",
      detail: {},
    });
    writeAuditEntry({
      project: "p",
      ticketKey: "HI-2",
      action: "JIRA_REASSIGNED",
      detail: {},
    });
    const auditFile = await getAuditFile();
    const lines = fs
      .readFileSync(auditFile, "utf8")
      .split("\n")
      .filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).ticketKey).toBe("HI-1");
    expect(JSON.parse(lines[1]).ticketKey).toBe("HI-2");
  });

  it("does not throw even if fs write fails", async () => {
    // Simulate unwritable directory by writing a file where dir should be
    const blocker = path.join(tmpHome, ".jira-acp");
    fs.writeFileSync(blocker, "blocker"); // file instead of dir
    const { writeAuditEntry } = await import("../utils/audit.js");
    expect(() =>
      writeAuditEntry({
        project: "p",
        ticketKey: "HI-1",
        action: "JIRA_COMMENT_ADDED",
        detail: {},
      }),
    ).not.toThrow();
  });
});
