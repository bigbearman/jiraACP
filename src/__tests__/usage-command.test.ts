import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { collectUsage, renderUsage } from "../commands/usage.js";

let runsDir: string;

beforeEach(() => {
  runsDir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-cmd-test-"));
});

afterEach(() => {
  fs.rmSync(runsDir, { recursive: true, force: true });
});

function writeRun(project: string, ticket: string, events: unknown[]): void {
  const dir = path.join(runsDir, project, ticket);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "state.json"),
    events.map((e) => JSON.stringify(e)).join("\n") + "\n",
  );
}

const started = (ticketKey: string, timestamp: string) => ({
  type: "STARTED",
  ticketKey,
  timestamp,
});

const completed = (stage: string, costUsd: number, inputTokens = 100) => ({
  type: "STAGE_COMPLETED",
  stage,
  timestamp: "2026-11-16T00:00:00.000Z",
  output: {
    tokenUsage: {
      inputTokens,
      outputTokens: 10,
      cacheCreationInputTokens: 5,
      cacheReadInputTokens: 50,
      model: "claude-sonnet-4-6",
      costUsd,
      calls: 1,
      byModel: {
        "claude-sonnet-4-6": {
          inputTokens,
          outputTokens: 10,
          cacheCreationInputTokens: 5,
          cacheReadInputTokens: 50,
          costUsd,
          pricing: "table",
        },
      },
    },
  },
});

describe("collectUsage", () => {
  beforeEach(() => {
    writeRun("alpha", "AL-1", [
      started("AL-1", "2026-11-01T10:00:00.000Z"),
      completed("analyze", 0.01),
      completed("code", 0.5),
      // Second run of the same ticket
      started("AL-1", "2026-11-02T10:00:00.000Z"),
      completed("code", 0.25),
      {
        type: "STAGE_FAILED",
        stage: "review",
        error: "boom",
        timestamp: "2026-11-02T10:05:00.000Z",
        tokenUsage: completed("review", 0.1).output.tokenUsage,
      },
    ]);
    writeRun("alpha", "AL-2", [
      started("AL-2", "2026-10-15T10:00:00.000Z"),
      completed("analyze", 0.02),
    ]);
    writeRun("beta", "BE-1", [
      started("BE-1", "2026-11-03T10:00:00.000Z"),
      { type: "STAGE_COMPLETED", stage: "fetch", output: { summary: "x" } },
    ]);
    writeRun("alpha", "__triage__", [
      started("__triage__", "2026-11-01T10:00:00.000Z"),
      completed("analyze", 9),
    ]);
  });

  it("totals cost per ticket, including failed stages", () => {
    const report = collectUsage(runsDir);
    const al1 = report.projects["alpha"].tickets["AL-1"];
    expect(al1.runs).toBe(2);
    expect(al1.costUsd).toBeCloseTo(0.86);
    expect(report.projects["alpha"].tickets["AL-2"].costUsd).toBeCloseTo(0.02);
    expect(report.projects["alpha"].costUsd).toBeCloseTo(0.88);
    expect(report.total.runs).toBe(3);
  });

  it("totals cost per stage, per ticket and across projects", () => {
    const report = collectUsage(runsDir);
    const al1 = report.projects["alpha"].tickets["AL-1"];
    expect(al1.stages["code"].executions).toBe(2);
    expect(al1.stages["code"].costUsd).toBeCloseTo(0.75);
    expect(al1.stages["review"].costUsd).toBeCloseTo(0.1);

    expect(report.stages["analyze"].executions).toBe(2);
    expect(report.stages["analyze"].costUsd).toBeCloseTo(0.03);
    expect(report.stages["code"].inputTokens).toBe(200);
    expect(report.stages["code"].cacheReadInputTokens).toBe(100);
  });

  it("skips projects with no token data and the triage scratch dir", () => {
    const report = collectUsage(runsDir);
    expect(report.projects["beta"]).toBeUndefined();
    expect(report.projects["alpha"].tickets["__triage__"]).toBeUndefined();
  });

  it("filters by month using each run's own start date", () => {
    const report = collectUsage(runsDir, { month: "2026-10" });
    expect(Object.keys(report.projects["alpha"].tickets)).toEqual(["AL-2"]);
    expect(report.total.costUsd).toBeCloseTo(0.02);
  });

  it("filters by project and ticket", () => {
    expect(collectUsage(runsDir, { project: "beta" }).total.runs).toBe(0);
    const report = collectUsage(runsDir, { ticket: "AL-2" });
    expect(Object.keys(report.projects["alpha"].tickets)).toEqual(["AL-2"]);
  });

  it("lists models that are not in the pricing table", () => {
    writeRun("gamma", "GA-1", [
      started("GA-1", "2026-11-04T10:00:00.000Z"),
      {
        type: "STAGE_COMPLETED",
        stage: "code",
        output: {
          tokenUsage: { inputTokens: 1, outputTokens: 1, model: "mystery-1" },
        },
      },
    ]);
    expect(collectUsage(runsDir).unpricedModels).toEqual(["mystery-1"]);
  });
});

describe("renderUsage", () => {
  it("shows tickets, a stage table and per-stage rows when verbose", () => {
    writeRun("alpha", "AL-1", [
      started("AL-1", "2026-11-01T10:00:00.000Z"),
      completed("code", 0.5),
    ]);
    const report = collectUsage(runsDir);

    const plain = renderUsage(report, {});
    expect(plain).toContain("AL-1");
    expect(plain).toContain("Stage");
    expect(plain).toContain("$0.5000");
    expect(plain).not.toContain("↳ code");

    expect(renderUsage(report, { verbose: true })).toContain("↳ code");
  });
});
