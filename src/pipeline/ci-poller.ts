import type { GitHubClient, CheckRun } from "../integrations/github/client.js";
import type { Logger } from "pino";

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

export interface CIPollConfig {
  timeoutMs: number;
  initialMs: number;
  multiplier: number;
  maxMs: number;
  requiredChecks: string[];
}

export interface CIResult {
  status: "success" | "failure" | "timeout";
  checks: CheckRun[];
  passedCount: number;
  failedCount: number;
  durationMs: number;
  failedLogs: { name: string; log: string }[];
  pendingChecks: string[];
}

export async function waitForCI(
  github: GitHubClient,
  sha: string,
  config: CIPollConfig,
  logger: Logger,
): Promise<CIResult> {
  const startTime = Date.now();
  let delay = config.initialMs;

  logger.info(
    { sha, timeoutMs: config.timeoutMs, requiredChecks: config.requiredChecks },
    "Starting CI polling",
  );

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const elapsed = Date.now() - startTime;
    if (elapsed >= config.timeoutMs) {
      const checks = await fetchChecks(github, sha);
      const pending = getPendingCheckNames(checks, config.requiredChecks);
      return {
        status: "timeout",
        checks,
        passedCount: checks.filter((c) => c.conclusion === "success").length,
        failedCount: checks.filter(
          (c) =>
            c.conclusion !== null &&
            c.conclusion !== "success" &&
            c.status === "completed",
        ).length,
        durationMs: elapsed,
        failedLogs: [],
        pendingChecks: pending,
      };
    }

    const checks = await fetchChecks(github, sha);

    // No checks on repo → immediate success
    if (checks.length === 0) {
      logger.info("No CI checks found on repo, treating as success");
      return {
        status: "success",
        checks: [],
        passedCount: 0,
        failedCount: 0,
        durationMs: Date.now() - startTime,
        failedLogs: [],
        pendingChecks: [],
      };
    }

    // Filter to required checks if configured
    const relevant =
      config.requiredChecks.length > 0
        ? filterRequired(checks, config.requiredChecks, logger)
        : checks;

    const allCompleted = relevant.every((c) => c.status === "completed");

    if (allCompleted) {
      const passed = relevant.filter((c) => c.conclusion === "success").length;
      const failed = relevant.filter((c) => c.conclusion !== "success");

      const failedLogs: { name: string; log: string }[] = [];
      for (const check of failed) {
        try {
          const log = await github.getCheckRunLog(check.id);
          failedLogs.push({ name: check.name, log });
        } catch (err) {
          logger.warn(
            { checkName: check.name, error: err },
            "Failed to fetch log for check run",
          );
          failedLogs.push({ name: check.name, log: "(log unavailable)" });
        }
      }

      const status = failed.length > 0 ? "failure" : "success";
      logger.info(
        { status, passed, failed: failed.length },
        "CI checks completed",
      );

      return {
        status,
        checks: relevant,
        passedCount: passed,
        failedCount: failed.length,
        durationMs: Date.now() - startTime,
        failedLogs,
        pendingChecks: [],
      };
    }

    const pending = relevant
      .filter((c) => c.status !== "completed")
      .map((c) => c.name);
    logger.debug(
      { pending, delayMs: delay },
      "CI checks still pending, waiting",
    );

    await sleep(delay);
    delay = Math.min(delay * config.multiplier, config.maxMs);
  }
}

async function fetchChecks(
  github: GitHubClient,
  sha: string,
): Promise<CheckRun[]> {
  return github.getCheckRuns(sha);
}

function filterRequired(
  checks: CheckRun[],
  requiredChecks: string[],
  logger: Logger,
): CheckRun[] {
  const checkNames = new Set(checks.map((c) => c.name));
  for (const required of requiredChecks) {
    if (!checkNames.has(required)) {
      logger.warn(
        { requiredCheck: required },
        "Required check not found in CI runs",
      );
    }
  }
  return checks.filter((c) => requiredChecks.includes(c.name));
}

function getPendingCheckNames(
  checks: CheckRun[],
  requiredChecks: string[],
): string[] {
  const relevant =
    requiredChecks.length > 0
      ? checks.filter((c) => requiredChecks.includes(c.name))
      : checks;
  return relevant.filter((c) => c.status !== "completed").map((c) => c.name);
}
