import pc from "picocolors";
import { spawnSafe } from "../utils/process.js";
import { configExists, loadConfig } from "../config/loader.js";
import type { ProjectConfig } from "../config/schema.js";
import axios from "axios";

export interface CheckResult {
  name: string;
  ok: boolean;
  message: string;
  // Passes, but is printed as a warning the user should read
  warn?: boolean;
}

export function mergeGateChecks(config: ProjectConfig): CheckResult[] {
  const autoMerge = config.github.autoMergeWithoutHumanApproval;
  const timeoutAction =
    config.telegram.humanInTheLoop.reviewApprovalTimeoutAction;
  const results: CheckResult[] = [];

  if (autoMerge) {
    results.push({
      name: "Human approval before merge",
      ok: true,
      warn: true,
      message: `OFF — github.autoMergeWithoutHumanApproval is true; PRs with fewer than ${config.github.majorIssueThreshold} major review issue(s) merge with no human approval`,
    });
  } else {
    results.push({
      name: "Human approval before merge",
      ok: true,
      message: "required for every merge",
    });
  }

  if (timeoutAction === "merge-anyway") {
    results.push({
      name: "Review approval timeout",
      ok: true,
      warn: true,
      message: autoMerge
        ? "merge-anyway — an unanswered approval request merges the PR"
        : "merge-anyway is ignored while auto-merge is off; timeout aborts",
    });
  }

  return results;
}

export async function runDoctor(
  projectName: string,
  _fix: boolean,
): Promise<void> {
  console.log(pc.bold(`\n  jiraACP doctor — ${projectName}\n`));

  const results: CheckResult[] = [];

  // 1. Node version
  const nodeVersion = process.version;
  results.push({
    name: "Node.js >= 20",
    ok: parseInt(nodeVersion.slice(1)) >= 20,
    message: nodeVersion,
  });

  // 2. claude CLI (subscription-based, no API key needed)
  const claudeResult = await spawnSafe("claude", ["--version"], {
    timeoutMs: 5_000,
  });
  results.push({
    name: "claude CLI installed",
    ok: claudeResult.exitCode === 0,
    message:
      claudeResult.stdout.trim() || claudeResult.stderr.trim() || "not found",
  });

  // 3. Project config
  const hasConfig = configExists(projectName);
  results.push({
    name: "project config exists",
    ok: hasConfig,
    message: hasConfig
      ? `~/.jira-acp/projects/${projectName}.json`
      : `Run: jiraACP init --name ${projectName}`,
  });

  if (!hasConfig) {
    printResults(results);
    return;
  }

  try {
    const config = loadConfig(projectName);

    // 4. Jira connectivity (using tokens from config)
    try {
      await axios.get(`${config.jira.url}/rest/api/3/myself`, {
        headers: {
          Authorization: `Basic ${Buffer.from(`${config.jira.email}:${config.jira.token}`).toString("base64")}`,
        },
        timeout: 5_000,
      });
      results.push({
        name: "Jira connectivity",
        ok: true,
        message: `${config.jira.url} ✓`,
      });
    } catch {
      results.push({
        name: "Jira connectivity",
        ok: false,
        message: `${config.jira.url} — connection failed`,
      });
    }

    // 5. GitHub token
    results.push({
      name: "GitHub token",
      ok: Boolean(config.github.token),
      message: config.github.token
        ? "set"
        : "empty — run: jiraACP config set github.token <token>",
    });

    // 6. Telegram bot token
    results.push({
      name: "Telegram bot token",
      ok: Boolean(config.telegram.botToken),
      message: config.telegram.botToken ? "set" : "empty",
    });

    // 7. Merge gate
    results.push(...mergeGateChecks(config));
  } catch (err) {
    results.push({ name: "Config load", ok: false, message: String(err) });
  }

  printResults(results);
}

function printResults(results: CheckResult[]): void {
  for (const r of results) {
    const icon = !r.ok ? pc.red("✗") : r.warn ? pc.yellow("!") : pc.green("✓");
    const name = !r.ok
      ? pc.red(r.name)
      : r.warn
        ? pc.yellow(r.name)
        : pc.green(r.name);
    console.log(`  ${icon}  ${name}  ${pc.gray(r.message)}`);
  }

  const failed = results.filter((r) => !r.ok);
  const warned = results.filter((r) => r.ok && r.warn);
  console.log();
  if (failed.length === 0) {
    console.log(
      warned.length === 0
        ? pc.green("  All checks passed.\n")
        : pc.yellow(`  All checks passed with ${warned.length} warning(s).\n`),
    );
  } else {
    console.log(pc.red(`  ${failed.length} check(s) failed.\n`));
    process.exitCode = 1;
  }
}
