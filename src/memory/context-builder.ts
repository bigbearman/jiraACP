import fs from "node:fs";
import path from "node:path";
import type { StageId } from "../config/schema.js";
import type { CIResult } from "../pipeline/ci-poller.js";

type ReviewAgentId = "logic" | "quality";

const REVIEW_AGENT_FILES: Record<ReviewAgentId, string> = {
  logic: "review-logic.md",
  quality: "review-quality.md",
};

export function writeTicketContext(
  memoryDir: string,
  ticket: {
    key: string;
    summary: string;
    description: string;
    acceptanceCriteria: string;
    priority: string;
    clarifications?: string;
  },
): void {
  fs.mkdirSync(memoryDir, { recursive: true });
  const content = `# Ticket: ${ticket.key}

## Summary
${ticket.summary}

## Description
${ticket.description || "(none)"}

## Acceptance Criteria
${ticket.acceptanceCriteria || "(none)"}

## Priority
${ticket.priority}
${ticket.clarifications ? `\n## Clarifications from Team\n${ticket.clarifications}` : ""}
`;
  fs.writeFileSync(path.join(memoryDir, "ticket-context.md"), content);
}

export function readTicketContext(memoryDir: string): string {
  const p = path.join(memoryDir, "ticket-context.md");
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
}

export function appendClarifications(memoryDir: string, answers: string): void {
  const p = path.join(memoryDir, "ticket-context.md");
  if (fs.existsSync(p)) {
    fs.appendFileSync(p, `\n## Clarifications from Team\n${answers}\n`);
  }
}

export function writeReviewFeedback(
  memoryDir: string,
  feedback: {
    prNumber: number;
    issues: { severity: "minor" | "major"; message: string }[];
    autoResolved: boolean;
  },
): void {
  const lines = [
    `# Review Results`,
    `PR: #${feedback.prNumber}`,
    `Major issues: ${feedback.issues.filter((i) => i.severity === "major").length}`,
    `Minor issues: ${feedback.issues.filter((i) => i.severity === "minor").length}`,
    `Auto-resolved: ${feedback.autoResolved}`,
    "",
    "## Issues",
    ...feedback.issues.map(
      (i) => `- [${i.severity.toUpperCase()}] ${i.message}`,
    ),
  ];
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.writeFileSync(
    path.join(memoryDir, "review-feedback.md"),
    lines.join("\n"),
  );
}

export function writeReviewAgentOutput(
  memoryDir: string,
  agentId: ReviewAgentId,
  raw: string,
): void {
  fs.mkdirSync(memoryDir, { recursive: true });
  const fileName = REVIEW_AGENT_FILES[agentId];
  fs.writeFileSync(path.join(memoryDir, fileName), raw);
}

export function writeCIStatus(memoryDir: string, result: CIResult): void {
  fs.mkdirSync(memoryDir, { recursive: true });

  const lines: string[] = [
    "# CI Status",
    "",
    `**Status:** ${result.status}`,
    `**Duration:** ${Math.round(result.durationMs / 1000)}s`,
    `**Passed:** ${result.passedCount} | **Failed:** ${result.failedCount}`,
    "",
  ];

  if (result.pendingChecks.length > 0) {
    lines.push("## Pending Checks");
    for (const name of result.pendingChecks) {
      lines.push(`- ${name}`);
    }
    lines.push("");
  }

  if (result.failedLogs.length > 0) {
    lines.push("## Failed Check Logs");
    for (const { name, log } of result.failedLogs) {
      lines.push(`### ${name}`);
      lines.push("```");
      lines.push(log);
      lines.push("```");
      lines.push("");
    }
  }

  if (result.checks.length > 0) {
    lines.push("## All Checks");
    for (const check of result.checks) {
      const icon =
        check.conclusion === "success"
          ? "pass"
          : check.status === "completed"
            ? "FAIL"
            : "pending";
      lines.push(
        `- [${icon}] ${check.name} (${check.conclusion ?? check.status})`,
      );
    }
    lines.push("");
  }

  fs.writeFileSync(path.join(memoryDir, "ci-status.md"), lines.join("\n"));
}

export function getContextFilesForStage(
  projectDir: string,
  memoryDir: string,
  stage: StageId,
): string[] {
  const claudeMd = path.join(projectDir, ".claude", "CLAUDE.md");
  const ticketCtx = path.join(memoryDir, "ticket-context.md");
  const reviewFeedback = path.join(memoryDir, "review-feedback.md");
  const ciStatus = path.join(memoryDir, "ci-status.md");

  const files: string[] = [];
  if (fs.existsSync(claudeMd)) files.push(claudeMd);

  if (["code", "git", "review", "deploy", "test", "notify"].includes(stage)) {
    if (fs.existsSync(ticketCtx)) files.push(ticketCtx);
  }
  if (stage === "review" && fs.existsSync(ciStatus)) {
    files.push(ciStatus);
  }
  if (stage === "test" && fs.existsSync(reviewFeedback)) {
    files.push(reviewFeedback);
  }
  return files;
}
