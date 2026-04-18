import type { ProjectConfig } from "../config/schema.js";
import type { Logger } from "pino";
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
