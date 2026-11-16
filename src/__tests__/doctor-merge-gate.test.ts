/**
 * doctor must make it visible when a merge can happen without a human.
 */
import { describe, it, expect } from "vitest";
import { ProjectConfigSchema } from "../config/schema.js";
import type { ProjectConfig } from "../config/schema.js";
import { mergeGateChecks } from "../commands/doctor.js";

function parseConfig(
  overrides: {
    github?: Record<string, unknown>;
    humanInTheLoop?: Record<string, unknown>;
  } = {},
): ProjectConfig {
  return ProjectConfigSchema.parse({
    name: "test",
    jira: {
      instance: "t",
      url: "https://test.atlassian.net",
      email: "dev@test.com",
      token: "token",
      projectKey: "T",
      assignees: ["me"],
    },
    github: { owner: "org", repo: "repo", token: "gh", ...overrides.github },
    workspace: { rootDir: "/tmp" },
    telegram: {
      botToken: "bot",
      chatId: "1",
      humanInTheLoop: overrides.humanInTheLoop,
    },
  });
}

describe("doctor mergeGateChecks", () => {
  it("reports the gate as required with no warning by default", () => {
    const results = mergeGateChecks(parseConfig());
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      ok: true,
      message: "required for every merge",
    });
    expect(results[0].warn).toBeUndefined();
  });

  it("warns when auto-merge is enabled", () => {
    const results = mergeGateChecks(
      parseConfig({ github: { autoMergeWithoutHumanApproval: true } }),
    );
    expect(results[0]).toMatchObject({ ok: true, warn: true });
    expect(results[0].message).toContain("autoMergeWithoutHumanApproval");
  });

  it("warns about merge-anyway timeouts", () => {
    const off = mergeGateChecks(
      parseConfig({
        humanInTheLoop: { reviewApprovalTimeoutAction: "merge-anyway" },
      }),
    );
    expect(off[1]).toMatchObject({ warn: true });
    expect(off[1].message).toContain("ignored");

    const on = mergeGateChecks(
      parseConfig({
        github: { autoMergeWithoutHumanApproval: true },
        humanInTheLoop: { reviewApprovalTimeoutAction: "merge-anyway" },
      }),
    );
    expect(on[1].message).toContain("merges the PR");
  });
});
