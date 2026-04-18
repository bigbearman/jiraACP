import { describe, it, expect } from "vitest";
import {
  ProjectConfigSchema,
  GlobalConfigSchema,
  StageId,
} from "../config/schema.js";

const minimalValid = {
  name: "test-project",
  jira: {
    instance: "myorg",
    url: "https://myorg.atlassian.net",
    email: "dev@myorg.com",
    token: "secret",
    projectKey: "PROJ",
    assignees: ["accountId-1"],
  },
  github: {
    owner: "myorg",
    repo: "my-repo",
    token: "ghp_secret",
  },
  workspace: { rootDir: "/home/user/my-repo" },
  telegram: {
    botToken: "123:ABC",
    chatId: "-1001234567890",
  },
};

describe("ProjectConfigSchema", () => {
  it("parses minimal valid config with defaults", () => {
    const result = ProjectConfigSchema.safeParse(minimalValid);
    expect(result.success).toBe(true);
    if (!result.success) return;

    // Defaults applied
    expect(result.data.jira.clarityScoreThreshold).toBe(0.7);
    expect(result.data.jira.doneTransition).toBe("Done");
    expect(result.data.github.defaultBranch).toBe("main");
    expect(result.data.github.autoMergeStrategy).toBe("squash");
    expect(result.data.pipeline.maxConcurrentRuns).toBe(2);
    expect(result.data.deploy.enabled).toBe(false);
    expect(result.data.test.enabled).toBe(false);
  });

  it("rejects config missing required name", () => {
    const { name: _, ...noName } = minimalValid;
    expect(ProjectConfigSchema.safeParse(noName).success).toBe(false);
  });

  it("rejects config with empty assignees array", () => {
    const bad = {
      ...minimalValid,
      jira: { ...minimalValid.jira, assignees: [] },
    };
    expect(ProjectConfigSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects invalid autoMergeStrategy", () => {
    const bad = {
      ...minimalValid,
      github: { ...minimalValid.github, autoMergeStrategy: "fast-forward" },
    };
    expect(ProjectConfigSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects clarityScoreThreshold > 1", () => {
    const bad = {
      ...minimalValid,
      jira: { ...minimalValid.jira, clarityScoreThreshold: 1.5 },
    };
    expect(ProjectConfigSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects clarityScoreThreshold < 0", () => {
    const bad = {
      ...minimalValid,
      jira: { ...minimalValid.jira, clarityScoreThreshold: -0.1 },
    };
    expect(ProjectConfigSchema.safeParse(bad).success).toBe(false);
  });

  it("accepts chatId as number", () => {
    const config = {
      ...minimalValid,
      telegram: { ...minimalValid.telegram, chatId: -1001234567890 },
    };
    const result = ProjectConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  it("applies default stageTimeouts", () => {
    const result = ProjectConfigSchema.safeParse(minimalValid);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.pipeline.stageTimeouts.fetch).toBe(30_000);
    expect(result.data.pipeline.stageTimeouts.code).toBe(1_800_000);
  });

  it("accepts optional topicId on telegram", () => {
    const config = {
      ...minimalValid,
      telegram: { ...minimalValid.telegram, topicId: 42 },
    };
    const result = ProjectConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.telegram.topicId).toBe(42);
  });

  it("accepts maxCostUsdPerRun in pipeline", () => {
    const config = {
      ...minimalValid,
      pipeline: { maxCostUsdPerRun: 2.5 },
    };
    const result = ProjectConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.pipeline.maxCostUsdPerRun).toBe(2.5);
  });
});

describe("GlobalConfigSchema", () => {
  it("accepts empty object (all fields optional)", () => {
    expect(GlobalConfigSchema.safeParse({}).success).toBe(true);
  });

  it("accepts partial telegram config", () => {
    const result = GlobalConfigSchema.safeParse({
      telegram: { botToken: "123:ABC" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts partial pipeline config", () => {
    const result = GlobalConfigSchema.safeParse({
      pipeline: { maxCostUsdPerRun: 2.0, failOnDeployFailure: true },
    });
    expect(result.success).toBe(true);
  });

  it("does not require name field", () => {
    // name is omitted from GlobalConfigSchema
    const result = GlobalConfigSchema.safeParse({ name: "should-be-ignored" });
    // name is not part of the schema so it's stripped or ignored — just shouldn't error
    expect(result.success).toBe(true);
  });
});

describe("StageId", () => {
  it("accepts all valid stage ids", () => {
    const stages = [
      "fetch",
      "analyze",
      "clarify",
      "code",
      "git",
      "review",
      "deploy",
      "test",
      "notify",
    ];
    for (const stage of stages) {
      expect(StageId.safeParse(stage).success).toBe(true);
    }
  });

  it("rejects unknown stage id", () => {
    expect(StageId.safeParse("unknown").success).toBe(false);
    expect(StageId.safeParse("").success).toBe(false);
  });
});
