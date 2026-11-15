import type { GitHubClient, CheckRun } from "../integrations/github/client.js";
import type { Logger } from "pino";

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

// Conclusions that do not block a merge on GitHub
const PASSING_CONCLUSIONS = new Set(["success", "skipped", "neutral"]);

export interface CIPollConfig {
  timeoutMs: number;
  initialMs: number;
  multiplier: number;
  maxMs: number;
  requiredChecks: string[];
  /** How long to wait for a first check run before deciding the repo has no CI */
  noChecksGraceMs: number;
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

const isPassing = (check: CheckRun): boolean =>
  check.conclusion !== null && PASSING_CONCLUSIONS.has(check.conclusion);

export async function waitForCI(
  github: GitHubClient,
  sha: string,
  config: CIPollConfig,
  logger: Logger,
): Promise<CIResult> {
  const startTime = Date.now();
  const required = config.requiredChecks;
  // A grace period longer than the whole budget would turn "no CI" into a timeout
  const graceMs = Math.min(config.noChecksGraceMs, config.timeoutMs);
  let delay = config.initialMs;
  let warnedMissing = false;

  logger.info(
    { sha, timeoutMs: config.timeoutMs, requiredChecks: required },
    "Starting CI polling",
  );

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const checks = await github.getCheckRuns(sha);
    const elapsed = Date.now() - startTime;

    const relevant =
      required.length > 0
        ? checks.filter((c) => required.includes(c.name))
        : checks;
    // A required check that has not been registered yet is still pending
    const missing = required.filter((n) => !checks.some((c) => c.name === n));
    const pendingChecks = [
      ...missing,
      ...relevant.filter((c) => c.status !== "completed").map((c) => c.name),
    ];
    const passedCount = relevant.filter(isPassing).length;
    const failed = relevant.filter(
      (c) => c.status === "completed" && !isPassing(c),
    );
    const base = {
      checks: relevant,
      passedCount,
      failedCount: failed.length,
      durationMs: elapsed,
    };

    // Check runs are registered a few seconds after the push, so an empty
    // list only means "no CI" once the grace period has passed.
    if (
      checks.length === 0 &&
      required.length === 0 &&
      elapsed >= graceMs
    ) {
      logger.info("No CI checks found on repo, treating as success");
      return { ...base, status: "success", failedLogs: [], pendingChecks: [] };
    }

    if (relevant.length > 0 && pendingChecks.length === 0) {
      const status = failed.length > 0 ? "failure" : "success";
      logger.info(
        { status, passed: passedCount, failed: failed.length },
        "CI checks completed",
      );
      return {
        ...base,
        status,
        failedLogs: await fetchFailedLogs(github, failed, logger),
        pendingChecks: [],
      };
    }

    if (elapsed >= config.timeoutMs) {
      return { ...base, status: "timeout", failedLogs: [], pendingChecks };
    }

    // A required check that never registers (typo, path-filtered workflow)
    // keeps the poll going until the timeout, so say which one it is.
    if (missing.length > 0 && elapsed >= graceMs && !warnedMissing) {
      warnedMissing = true;
      logger.warn(
        { missing },
        "Required checks not registered yet — still waiting for them",
      );
    }

    logger.debug(
      { pending: pendingChecks, delayMs: delay },
      "CI checks still pending, waiting",
    );
    // While no check exists yet, never sleep past the end of the grace period
    const untilGrace =
      checks.length === 0 && required.length === 0
        ? graceMs - elapsed
        : Infinity;
    await sleep(Math.min(delay, config.timeoutMs - elapsed, untilGrace));
    delay = Math.min(delay * config.multiplier, config.maxMs);
  }
}

async function fetchFailedLogs(
  github: GitHubClient,
  failed: CheckRun[],
  logger: Logger,
): Promise<{ name: string; log: string }[]> {
  const logs: { name: string; log: string }[] = [];
  for (const check of failed) {
    try {
      logs.push({
        name: check.name,
        log: await github.getCheckRunLog(check.id),
      });
    } catch (err) {
      logger.warn(
        { checkName: check.name, error: err },
        "Failed to fetch log for check run",
      );
      logs.push({ name: check.name, log: "(log unavailable)" });
    }
  }
  return logs;
}
