import { spawn } from "node:child_process";

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface SpawnOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  stallTimeoutMs?: number;
  onStdout?: (chunk: string) => void;
}

/** Spawn a process safely — args as array, never shell string (no injection risk) */
export async function spawnSafe(
  bin: string,
  args: string[],
  opts: SpawnOptions = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, {
      cwd: opts.cwd,
      env: opts.env ?? buildMinimalEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let stallTimer: NodeJS.Timeout | undefined;
    let globalTimer: NodeJS.Timeout | undefined;

    const resetStall = (): void => {
      if (stallTimer) clearTimeout(stallTimer);
      if (opts.stallTimeoutMs) {
        stallTimer = setTimeout(() => {
          proc.kill("SIGKILL");
          reject(
            new Error(
              `Process stalled (no output for ${opts.stallTimeoutMs}ms)`,
            ),
          );
        }, opts.stallTimeoutMs);
      }
    };

    if (opts.timeoutMs) {
      globalTimer = setTimeout(() => {
        proc.kill("SIGKILL");
        reject(new Error(`Process timed out after ${opts.timeoutMs}ms`));
      }, opts.timeoutMs);
    }

    resetStall();

    proc.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      opts.onStdout?.(text);
      resetStall();
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("close", (code) => {
      if (stallTimer) clearTimeout(stallTimer);
      if (globalTimer) clearTimeout(globalTimer);
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });

    proc.on("error", (err) => {
      if (stallTimer) clearTimeout(stallTimer);
      if (globalTimer) clearTimeout(globalTimer);
      reject(err);
    });
  });
}

const ENV_WHITELIST = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "TMPDIR",
  "LC_*",
  "XDG_*",
  "GIT_*",
  "SSH_AUTH_SOCK",
  "SSH_AGENT_PID",
  "ANTHROPIC_API_KEY",
];

function matchesPattern(key: string, pattern: string): boolean {
  return pattern.endsWith("*")
    ? key.startsWith(pattern.slice(0, -1))
    : key === pattern;
}

/** Forward a safe subset of env vars — never spread full process.env */
export function buildMinimalEnv(
  extra: Record<string, string> = {},
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (ENV_WHITELIST.some((p) => matchesPattern(key, p))) {
      result[key] = value;
    }
  }
  return { ...result, ...extra };
}
