import type { Stage, PipelineContext, StageOutput } from "./types.js";
import { spawnSafe, buildMinimalEnv } from "../../utils/process.js";
import { executeRollback } from "../rollback.js";

export const deployStage: Stage = {
  id: "deploy",
  name: "Deploy",
  model: "haiku",

  async shouldSkip(ctx: PipelineContext): Promise<boolean> {
    return !ctx.config.deploy?.enabled;
  },

  async run(ctx: PipelineContext): Promise<StageOutput> {
    const { config, ticketKey } = ctx;
    const deploy = config.deploy;

    if (!deploy?.command) throw new Error("deploy.command not configured");

    ctx.logger.info({ ticketKey }, "Deploying to dev server");
    await ctx.telegram
      .updateDetail(`Running: <code>${deploy.command}</code>…`)
      .catch(() => undefined);

    if (ctx.dryRun) {
      if (deploy.rollbackCommand) {
        ctx.logger.info({ ticketKey }, "Would execute rollback on failure");
      }
      return { deployed: false, dryRun: true };
    }

    try {
      const result = await spawnSafe(deploy.command, [], {
        cwd: config.workspace.rootDir,
        env: buildMinimalEnv(deploy.env ?? {}),
        timeoutMs: deploy.timeoutMs ?? 1_200_000,
      });

      if (result.exitCode !== 0) {
        throw new Error(
          `Deploy failed (exit ${result.exitCode}):\n${result.stderr}`,
        );
      }

      // Health check
      if (deploy.healthCheckUrl) {
        await ctx.telegram
          .updateDetail(`Checking health: ${deploy.healthCheckUrl}…`)
          .catch(() => undefined);
        await healthCheck(
          deploy.healthCheckUrl,
          deploy.healthCheckTimeoutMs ?? 30_000,
        );
      }
    } catch (deployError) {
      if (deploy.rollbackCommand) {
        await attemptRollback(ctx, "deploy");
      }
      throw deployError;
    }

    ctx.logger.info({ ticketKey }, "Deploy successful");
    return { deployed: true, deployUrl: deploy.healthCheckUrl };
  },
};

async function healthCheck(url: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      if (res.ok) return;
    } catch {
      /* keep retrying */
    }
    await sleep(2_000);
  }
  throw new Error(`Health check timed out after ${timeoutMs}ms: ${url}`);
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

async function attemptRollback(
  ctx: PipelineContext,
  trigger: "deploy" | "test",
): Promise<void> {
  try {
    const rollbackResult = await executeRollback(ctx.config, {
      ticketKey: ctx.ticketKey,
      branchName: ctx.state.current.branchName ?? undefined,
      logger: ctx.logger,
    });

    ctx.state.emit({
      type: "DEPLOY_ROLLED_BACK",
      trigger,
      success: rollbackResult.success,
      durationMs: rollbackResult.durationMs,
    });

    await ctx.telegram
      .notifyRollback(ctx.ticketKey, {
        trigger,
        success: rollbackResult.success,
        error: rollbackResult.success ? undefined : rollbackResult.stderr,
      })
      .catch(() => undefined);
  } catch (rollbackError) {
    const errorMsg =
      rollbackError instanceof Error
        ? rollbackError.message
        : String(rollbackError);

    ctx.state.emit({
      type: "DEPLOY_ROLLED_BACK",
      trigger,
      success: false,
      durationMs: 0,
    });

    await ctx.telegram
      .notifyRollback(ctx.ticketKey, {
        trigger,
        success: false,
        error: errorMsg,
      })
      .catch(() => undefined);

    ctx.logger.error(
      { ticketKey: ctx.ticketKey, error: errorMsg },
      "Rollback itself failed",
    );
  }
}
