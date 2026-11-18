import type { Stage, PipelineContext, StageOutput } from "./types.js";
import { runAgentsParallel } from "../runner.js";
import {
  getContextFilesForStage,
  writeReviewFeedback,
  writeReviewAgentOutput,
} from "../../memory/context-builder.js";
import { requestApproval } from "../../integrations/telegram/human-loop.js";

export const reviewStage: Stage = {
  id: "review",
  name: "Review",
  model: "sonnet",

  async run(ctx: PipelineContext): Promise<StageOutput> {
    const { config, ticketKey, state, memoryDir, projectDir } = ctx;
    const prNumber = state.current.prNumber;
    if (!prNumber)
      throw new Error("No PR number in state — git stage must run first");

    const contextFiles = getContextFilesForStage(
      projectDir,
      memoryDir,
      "review",
    );
    ctx.logger.info({ ticketKey, prNumber }, "Running parallel review agents");
    await ctx.telegram
      .updateDetail(`Running parallel review agents on PR #${prNumber}…`)
      .catch(() => undefined);

    const logicPrompt = `Review PR #${prNumber} for ticket ${ticketKey}.
Focus on: Does the implementation correctly satisfy the acceptance criteria?
List issues as JSON: { "issues": [{ "severity": "minor"|"major", "message": "..." }] }`;

    const qualityPrompt = `Review PR #${prNumber} for ticket ${ticketKey}.
Focus on: Missing tests, security issues, type safety, performance red flags.
List issues as JSON: { "issues": [{ "severity": "minor"|"major", "message": "..." }] }`;

    const agentOpts = {
      workdir: config.workspace.rootDir,
      model: "sonnet" as const,
      contextFiles,
      timeoutMs: (config.pipeline?.stageTimeouts?.review ?? 600_000) / 2,
      stallTimeoutMs: 120_000,
      logger: ctx.logger,
    };

    const [logicRaw, qualityRaw] = ctx.dryRun
      ? ['{"issues":[]}', '{"issues":[]}']
      : await runAgentsParallel(
          { ...agentOpts, prompt: logicPrompt },
          { ...agentOpts, prompt: qualityPrompt },
        );

    // Keep each agent's raw output for debugging
    writeReviewAgentOutput(memoryDir, "logic", logicRaw);
    writeReviewAgentOutput(memoryDir, "quality", qualityRaw);

    const issues = [...parseIssues(logicRaw), ...parseIssues(qualityRaw)];

    const majorCount = issues.filter((i) => i.severity === "major").length;
    // A human approves every merge unless auto-merge is explicitly opted into;
    // only then does a clean review skip the Telegram gate.
    const autoMerge = config.github.autoMergeWithoutHumanApproval ?? false;
    const threshold = config.github.majorIssueThreshold ?? 1;
    const needsHumanApproval = !autoMerge || majorCount >= threshold;

    writeReviewFeedback(memoryDir, {
      prNumber,
      issues,
      autoResolved: !needsHumanApproval,
    });

    const reviewSummary =
      issues.length === 0
        ? "No issues found"
        : `${majorCount} major, ${issues.length - majorCount} minor issue(s)`;
    await ctx.telegram.updateDetail(reviewSummary).catch(() => undefined);

    if (ctx.dryRun) {
      ctx.logger.info(
        { ticketKey, prNumber, majorCount, needsHumanApproval },
        "Dry run — human approval gate skipped, PR not merged",
      );
      return { prNumber, issues, merged: false };
    }

    if (needsHumanApproval) {
      ctx.logger.warn(
        { ticketKey, majorCount },
        "Requesting human approval via Telegram before merge",
      );
      await ctx.telegram
        .updateDetail(`⚠️ ${reviewSummary} — waiting for human approval…`)
        .catch(() => undefined);

      ctx.state.emit({
        type: "HUMAN_APPROVAL_REQUESTED",
        context: { prNumber, majorCount },
      });

      const hil = config.telegram.humanInTheLoop;
      const configuredTimeoutAction =
        hil?.reviewApprovalTimeoutAction ?? "abort";
      // "merge-anyway" would merge with no human decision, so it counts as
      // auto-merge and needs the same opt-in.
      const onTimeout =
        configuredTimeoutAction === "merge-anyway" && !autoMerge
          ? "abort"
          : configuredTimeoutAction;
      if (onTimeout !== configuredTimeoutAction) {
        ctx.logger.warn(
          { ticketKey },
          'reviewApprovalTimeoutAction "merge-anyway" ignored — github.autoMergeWithoutHumanApproval is off; timeout will abort',
        );
      }

      const approved = await requestApproval(
        config.telegram.botToken,
        config.telegram.chatId,
        ticketKey,
        issues,
        {
          timeoutMs: hil?.reviewApprovalTimeoutMs ?? 86_400_000,
          onTimeout,
          topicId: config.telegram.topicId,
          reminderIntervalMs: hil?.reminderIntervalMs,
          maxReminders: hil?.maxReminders,
          onReminder: (count) =>
            ctx.state.emit({
              type: "APPROVAL_REMINDER_SENT",
              count,
            }),
        },
      );

      if (approved) {
        ctx.state.emit({ type: "HUMAN_APPROVED" });
        ctx.logger.info(
          { ticketKey, prNumber },
          "Human approved — proceeding to merge",
        );
      } else {
        ctx.state.emit({
          type: "HUMAN_REJECTED",
          reason: "Reviewer rejected PR",
        });
        throw new Error(`REVIEW_REJECTED:PR #${prNumber} rejected by reviewer`);
      }
    }

    // Post-approval merge, or opted-in auto-merge of a clean review
    await ctx.github.mergePR(
      prNumber,
      config.github.autoMergeStrategy ?? "squash",
    );
    ctx.logger.info({ ticketKey, prNumber }, "PR merged");

    return { prNumber, issues, merged: true };
  },
};

function parseIssues(
  raw: string,
): Array<{ severity: "minor" | "major"; message: string }> {
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return [];
    const parsed = JSON.parse(match[0]) as {
      issues?: Array<{ severity: string; message: string }>;
    };
    return (parsed.issues ?? []).map((i) => ({
      severity: i.severity === "major" ? "major" : "minor",
      message: i.message,
    }));
  } catch {
    return [];
  }
}
