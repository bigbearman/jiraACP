import fs from "node:fs";
import path from "node:path";

const DEFAULT_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 200;
const STALE_THRESHOLD_MS = 60_000;

export class FileLockTimeout extends Error {
  constructor(filePath: string, timeoutMs: number) {
    super(`Failed to acquire file lock on "${filePath}" within ${timeoutMs}ms`);
    this.name = "FileLockTimeout";
  }
}

interface FileLockData {
  pid: number;
  acquiredAt: string;
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

function tryUnlink(p: string): void {
  try {
    fs.unlinkSync(p);
  } catch {
    /* ignore */
  }
}

function isLockStale(lockPath: string): boolean {
  try {
    const raw = fs.readFileSync(lockPath, "utf8");
    const data = JSON.parse(raw) as FileLockData;
    const age = Date.now() - new Date(data.acquiredAt).getTime();
    return age > STALE_THRESHOLD_MS;
  } catch {
    // Unreadable lock — treat as stale
    return true;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function lockPathFor(filePath: string): string {
  return `${filePath}.lock`;
}

function tryAcquire(lockPath: string): boolean {
  const dir = path.dirname(lockPath);
  fs.mkdirSync(dir, { recursive: true });

  const data: FileLockData = {
    pid: process.pid,
    acquiredAt: new Date().toISOString(),
  };

  try {
    fs.writeFileSync(lockPath, JSON.stringify(data), { flag: "wx" }); // O_EXCL
    return true;
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === "EEXIST") {
      if (isLockStale(lockPath)) {
        // Stale lock — steal it
        fs.writeFileSync(lockPath, JSON.stringify(data));
        return true;
      }
      return false;
    }
    throw err;
  }
}

export async function withFileLock<T>(
  filePath: string,
  fn: () => T | Promise<T>,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const lockPath = lockPathFor(filePath);
  const deadline = Date.now() + timeoutMs;

  while (!tryAcquire(lockPath)) {
    if (Date.now() >= deadline) {
      throw new FileLockTimeout(filePath, timeoutMs);
    }
    await sleep(POLL_INTERVAL_MS);
  }

  try {
    return await fn();
  } finally {
    tryUnlink(lockPath);
  }
}
