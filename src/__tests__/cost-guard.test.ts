import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TelegramNotifier } from "../integrations/telegram/notifier.js";
import { checkCostLimit } from "../pipeline/cost-guard.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jira-cost-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeTelegram(): TelegramNotifier {
  return {
    send: vi.fn().mockResolvedValue(undefined),
    sendError: vi.fn(),
    sendDone: vi.fn(),
    notifyStageStarted: vi.fn(),
    notifyStageCompleted: vi.fn(),
    notifyStageFailed: vi.fn(),
    notifyStageSkipped: vi.fn(),
  } as TelegramNotifier;
}

function writeStateEvents(runDir: string, events: unknown[]): void {
  fs.mkdirSync(runDir, { recursive: true });
  const lines = events.map((e) => JSON.stringify(e)).join("\n");
  fs.writeFileSync(path.join(runDir, "state.json"), lines);
}

const stageCompleted = (
  inputTokens: number,
  outputTokens: number,
  model = "claude-haiku-4-5-20251001",
) => ({
  type: "STAGE_COMPLETED",
  stage: "fetch",
  output: { tokenUsage: { inputTokens, outputTokens, model } },
});

describe("checkCostLimit", () => {
  it("returns 'continue' when no events exist", async () => {
    const tg = makeTelegram();
    const result = await checkCostLimit({
      runDir: tmpDir,
      maxCostUsd: 1.0,
      telegram: tg,
      ticketKey: "HI-1",
    });
    expect(result).toBe("continue");
    expect(tg.send).not.toHaveBeenCalled();
  });

  it("returns 'continue' when cost is below limit", async () => {
    const tg = makeTelegram();
    // 1000 tokens each → very cheap
    writeStateEvents(tmpDir, [stageCompleted(1000, 1000)]);

    const result = await checkCostLimit({
      runDir: tmpDir,
      maxCostUsd: 10.0,
      telegram: tg,
      ticketKey: "HI-1",
    });
    expect(result).toBe("continue");
    expect(tg.send).not.toHaveBeenCalled();
  });

  it("returns 'abort' and sends telegram when cost exceeds limit", async () => {
    const tg = makeTelegram();
    // 1M input + 1M output tokens at sonnet pricing = $3 + $15 = $18
    writeStateEvents(tmpDir, [
      stageCompleted(1_000_000, 1_000_000, "claude-sonnet-4"),
    ]);

    const result = await checkCostLimit({
      runDir: tmpDir,
      maxCostUsd: 1.0,
      telegram: tg,
      ticketKey: "HI-2",
    });
    expect(result).toBe("abort");
    expect(tg.send).toHaveBeenCalledOnce();
    const msg = (tg.send as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string;
    expect(msg).toContain("HI-2");
    expect(msg).toContain("Cost limit reached");
  });

  it("sends 80% warning but continues when cost is 80-99% of limit", async () => {
    const tg = makeTelegram();
    // sonnet: $3/1M input, $15/1M output
    // 500k input ($1.5) + 100k output ($1.5) = $3 total
    // maxCostUsd = $4 → 75%... let me use exact numbers
    // Use 267k input tokens at sonnet = $0.80, limit $1.00 → 80%
    writeStateEvents(tmpDir, [
      stageCompleted(800_000, 0, "claude-sonnet-4"), // $2.4 at $3/1M input
    ]);

    const result = await checkCostLimit({
      runDir: tmpDir,
      maxCostUsd: 3.0,
      telegram: tg,
      ticketKey: "HI-3",
    });
    expect(result).toBe("continue");
    expect(tg.send).toHaveBeenCalledOnce();
    const msg = (tg.send as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string;
    expect(msg).toContain("80%");
  });

  it("ignores non-STAGE_COMPLETED events", async () => {
    const tg = makeTelegram();
    writeStateEvents(tmpDir, [
      { type: "STAGE_STARTED", stage: "fetch" },
      { type: "PIPELINE_STARTED" },
    ]);

    const result = await checkCostLimit({
      runDir: tmpDir,
      maxCostUsd: 0.001,
      telegram: tg,
      ticketKey: "HI-4",
    });
    // No tokenUsage → cost stays 0 → continue
    expect(result).toBe("continue");
    expect(tg.send).not.toHaveBeenCalled();
  });

  it("ignores events with no tokenUsage", async () => {
    const tg = makeTelegram();
    writeStateEvents(tmpDir, [
      { type: "STAGE_COMPLETED", stage: "fetch", output: { summary: "ok" } },
    ]);

    const result = await checkCostLimit({
      runDir: tmpDir,
      maxCostUsd: 0.001,
      telegram: tg,
      ticketKey: "HI-5",
    });
    expect(result).toBe("continue");
  });
});
