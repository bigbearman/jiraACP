import type { Stage, PipelineContext, StageOutput } from "./types.js";
import { spawnSafe } from "../../utils/process.js";
import {
  readTicketContext,
  writeCIStatus,
} from "../../memory/context-builder.js";
import { waitForCI } from "../ci-poller.js";
import type { CIPollConfig } from "../ci-poller.js";

export const gitStage: Stage = {
  id: "git",
  name: "Git & PR",
  model: "haiku",

  async run(ctx: PipelineContext): Promise<StageOutput> {
    const { config, ticketKey, state } = ctx;
    const branchName = state.current.branchName;
    if (!branchName)
      throw new Error("No branch name in state — code stage must run first");

    const workdir = config.workspace.rootDir;
    const ticketCtx = readTicketContext(ctx.memoryDir);
    const summaryLine = ticketCtx
      .split("\n")
      .find((l) => l.startsWith("## Summary"));
    const summary =
      ticketCtx.split("\n")[
        ticketCtx.split("\n").indexOf(summaryLine ?? "") + 1
      ] ?? ticketKey;

    ctx.logger.info(
      { ticketKey, branchName },
      "Pushing branch and creating PR",
    );
    await ctx.telegram
      .updateDetail(
        `Pushing branch <code>${branchName}</code> and creating PR…`,
      )
      .catch(() => undefined);

    if (!ctx.dryRun) {
      // Push branch
      const pushResult = await spawnSafe(
        "git",
        ["push", "origin", branchName],
        { cwd: workdir },
      );
      if (pushResult.exitCode !== 0) {
        const pushErr = classifyPushError(pushResult.stderr, branchName);
        if (!pushErr.message.startsWith("BRANCH_ALREADY_EXISTS")) throw pushErr;
        // Branch already on remote — skip push, proceed to createPR
        ctx.logger.warn(
          { ticketKey, branchName },
          "Branch already on remote — skipping push",
        );
        await ctx.telegram
          .updateDetail(`Branch already on remote, creating PR…`)
          .catch(() => undefined);
      }

      // Create PR via GitHub client
      let prNumber: number;
      try {
        prNumber = await ctx.github.createPR({
          title: `[${ticketKey}] ${summary.trim()}`,
          body: buildPrBody(ticketKey, ticketCtx),
          head: branchName,
          base: config.github.defaultBranch ?? "main",
          draft: config.github.prDraftByDefault ?? false,
        });
      } catch (err) {
        const createErr = classifyCreatePrError(err, branchName);
        if (!createErr.message.startsWith("PR_ALREADY_OPEN")) throw createErr;
        // PR already open — find it and reuse
        const existing = await ctx.github.findOpenPR(branchName);
        if (existing === null) {
          throw new Error(
            `PR_NOT_FOUND: PR already exists for '${branchName}' but could not be located via API`,
          );
        }
        ctx.logger.warn(
          { ticketKey, branchName, prNumber: existing },
          "PR already open — reusing",
        );
        await ctx.telegram
          .updateDetail(`PR #${existing} already open — reusing`)
          .catch(() => undefined);
        prNumber = existing;
      }

      if (config.github.reviewers?.length) {
        await ctx.github.addReviewers(prNumber, config.github.reviewers);
      }

      ctx.logger.info({ ticketKey, prNumber }, "PR created");
      await ctx.telegram
        .updateDetail(`PR #${prNumber} created`)
        .catch(() => undefined);

      // CI polling after PR creation
      if (config.github.waitForCI !== false) {
        const shaResult = await spawnSafe("git", ["rev-parse", "HEAD"], {
          cwd: workdir,
        });
        const sha = shaResult.stdout.trim();

        const backoff = config.github.ciPollBackoff ?? {};
        const pollConfig: CIPollConfig = {
          timeoutMs: config.github.ciTimeoutMs ?? 1_800_000,
          initialMs: backoff.initialMs ?? 5_000,
          multiplier: backoff.multiplier ?? 2,
          maxMs: backoff.maxMs ?? 60_000,
          requiredChecks: config.github.requiredChecks ?? [],
          noChecksGraceMs: config.github.ciNoChecksGraceMs ?? 60_000,
        };

        state.emit({
          type: "CI_POLLING_STARTED",
          sha,
          requiredChecks: pollConfig.requiredChecks,
          timeoutMs: pollConfig.timeoutMs,
        });

        await ctx.telegram
          .updateDetail("Waiting for CI checks…")
          .catch(() => undefined);

        const ciResult = await waitForCI(
          ctx.github,
          sha,
          pollConfig,
          ctx.logger,
        );

        if (ciResult.status === "timeout") {
          state.emit({
            type: "CI_TIMEOUT",
            elapsedMs: ciResult.durationMs,
            pendingChecks: ciResult.pendingChecks,
          });
        } else {
          state.emit({
            type: "CI_COMPLETED",
            status: ciResult.status,
            passedCount: ciResult.passedCount,
            failedCount: ciResult.failedCount,
            durationMs: ciResult.durationMs,
          });
        }

        writeCIStatus(ctx.memoryDir, ciResult);
        await ctx.telegram
          .updateDetail(`CI: ${ciResult.status}`)
          .catch(() => undefined);
      }

      return { branchName, prNumber };
    }

    // Dry-run mode
    if (config.github.waitForCI !== false) {
      ctx.logger.info("Would wait for CI checks (skipped in dry-run mode)");
    }

    return { branchName, prNumber: null };
  },
};

function classifyPushError(stderr: string, branchName: string): Error {
  const lower = stderr.toLowerCase();
  if (lower.includes("already exists")) {
    return new Error(
      `BRANCH_ALREADY_EXISTS: branch '${branchName}' already exists on remote.\n${stderr}`,
    );
  }
  // "src refspec X does not match any" = the branch is missing locally
  if (lower.includes("src refspec")) {
    return new Error(
      `GIT_BRANCH_MISSING: local branch '${branchName}' does not exist — the code stage did not create or commit it.\n${stderr}`,
    );
  }
  if (lower.includes("permission denied") || lower.includes("permission to")) {
    return new Error(
      `GIT_AUTH_FAILED: permission denied pushing to remote.\n${stderr}`,
    );
  }
  return new Error(`GIT_PUSH_FAILED: ${stderr}`);
}

function classifyCreatePrError(err: unknown, branchName: string): Error {
  const message = err instanceof Error ? err.message : String(err);
  if (message.toLowerCase().includes("already exists")) {
    return new Error(
      `PR_ALREADY_OPEN: a pull request already exists for branch '${branchName}'.\n${message}`,
    );
  }
  return new Error(`GITHUB_CREATE_PR_FAILED: ${message}`);
}

function buildPrBody(ticketKey: string, ticketCtx: string): string {
  return `## ${ticketKey}

${ticketCtx}

---
*Generated by jiraACP automated pipeline*`;
}
