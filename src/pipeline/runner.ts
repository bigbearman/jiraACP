import fs from "node:fs";
import path from "node:path";
import type { Logger } from "pino";
import { spawnSafe, buildMinimalEnv } from "../utils/process.js";

export type AgentModel = "haiku" | "sonnet" | "opus";

const MODEL_IDS: Record<AgentModel, string> = {
  haiku: "claude-haiku-4-5-20251001",
  sonnet: "claude-sonnet-4-6",
  opus: "claude-opus-4-6",
};

export interface RunAgentOptions {
  prompt: string;
  workdir: string;
  model: AgentModel;
  contextFiles?: string[];
  timeoutMs?: number;
  stallTimeoutMs?: number;
  extraEnv?: Record<string, string>;
  logger?: Logger;
}

export async function runAgent(opts: RunAgentOptions): Promise<string> {
  const args = [
    "--model",
    MODEL_IDS[opts.model],
    "--print",
    "--output-format",
    "text",
  ];

  // --add-dir grants Claude read access to directories containing context files
  const existingFiles = (opts.contextFiles ?? []).filter(fs.existsSync);
  const dirs = [...new Set(existingFiles.map((f) => path.dirname(f)))];
  for (const dir of dirs) {
    args.push("--add-dir", dir);
  }

  // Tell Claude which files to read so it picks them up automatically
  const prompt =
    existingFiles.length > 0
      ? `${opts.prompt}\n\nContext files to read:\n${existingFiles.map((f) => `- ${f}`).join("\n")}`
      : opts.prompt;

  args.push(prompt);

  let outputLines = 0;
  const result = await spawnSafe("claude", args, {
    cwd: opts.workdir,
    env: buildMinimalEnv(opts.extraEnv),
    timeoutMs: opts.timeoutMs ?? 1_800_000,
    stallTimeoutMs: opts.stallTimeoutMs ?? 300_000,
    onStdout(chunk) {
      outputLines += chunk.split("\n").length - 1;
      opts.logger?.debug({ outputLines }, chunk.trimEnd());
    },
  });

  if (result.exitCode !== 0) {
    throw new Error(
      `Agent exited with code ${result.exitCode}:\n${result.stderr}`,
    );
  }

  return result.stdout.trim();
}

/** Run two agents in parallel and return both outputs */
export async function runAgentsParallel(
  a: RunAgentOptions,
  b: RunAgentOptions,
): Promise<[string, string]> {
  return Promise.all([runAgent(a), runAgent(b)]);
}

/** Detect if a task is complex enough to warrant Opus */
export function detectComplexity(description: string): AgentModel {
  const complexKeywords = [
    "auth",
    "payment",
    "stripe",
    "oauth",
    "jwt",
    "migration",
    "schema",
    "database",
    "refactor",
    "cross-module",
    "multi-service",
    "security",
    "encryption",
    "permission",
  ];
  const lower = description.toLowerCase();
  const matches = complexKeywords.filter((k) => lower.includes(k));
  return matches.length >= 2 ? "opus" : "sonnet";
}
