import type { ProjectConfig } from "../config/schema.js";
import type { Logger } from "pino";
import type { PipelineContext } from "./stages/types.js";
import { spawnSafe, buildMinimalEnv } from "../utils/process.js";

export interface RollbackResult {
  success: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
}

interface RollbackContext {
  ticketKey: string;
  branchName?: string;
  prUrl?: string;
  logger: Logger;
}

export async function executeRollback(
  config: ProjectConfig,
  context: RollbackContext,
): Promise<RollbackResult> {
  const rollbackCommand = config.deploy.rollbackCommand;
  if (!rollbackCommand) {
    throw new Error("deploy.rollbackCommand is not configured");
  }

  const timeoutMs = config.deploy.rollbackTimeoutMs ?? 60_000;

  context.logger.info(
    { ticketKey: context.ticketKey, rollbackCommand, timeoutMs },
    "Executing rollback command",
  );

  const start = Date.now();

  const result = await spawnSafe(rollbackCommand, [], {
    cwd: config.workspace.rootDir,
    env: buildMinimalEnv({
      ...config.deploy.env,
      JIRA_ACP_TICKET: context.ticketKey,
      BRANCH: context.branchName ?? "",
      PR_URL: context.prUrl ?? "",
    }),
    timeoutMs,
  });

  const durationMs = Date.now() - start;
  const success = result.exitCode === 0;

  context.logger.info(
    {
      ticketKey: context.ticketKey,
      success,
      durationMs,
      exitCode: result.exitCode,
    },
    "Rollback command completed",
  );

  return {
    success,
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs,
  };
}

/** Runs the rollback command and reports the outcome; never throws. */
export async function attemptRollback(
  ctx: PipelineContext,
  trigger: "deploy" | "test",
): Promise<void> {
  let success = false;
  let durationMs = 0;
  let error: string | undefined;
  try {
    const result = await executeRollback(ctx.config, {
      ticketKey: ctx.ticketKey,
      branchName: ctx.state.current.branchName ?? undefined,
      logger: ctx.logger,
    });
    success = result.success;
    durationMs = result.durationMs;
    error = result.success ? undefined : result.stderr;
  } catch (rollbackError) {
    error =
      rollbackError instanceof Error
        ? rollbackError.message
        : String(rollbackError);
    ctx.logger.error(
      { ticketKey: ctx.ticketKey, error },
      "Rollback itself failed",
    );
  }

  ctx.state.emit({ type: "DEPLOY_ROLLED_BACK", trigger, success, durationMs });
  await ctx.telegram
    .notifyRollback(ctx.ticketKey, { trigger, success, error })
    .catch(() => undefined);
}
