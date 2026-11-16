/**
 * `init` wizard must not opt the user into deploy or test: pressing Enter on
 * every prompt has to leave both disabled.
 */
import { describe, it, expect, vi } from "vitest";
import { ProjectConfigSchema } from "../config/schema.js";

const saved: unknown[] = [];

vi.mock("@clack/prompts", () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  note: vi.fn(),
  cancel: vi.fn(),
  isCancel: vi.fn(() => false),
  spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
  text: vi.fn().mockResolvedValue("value"),
  password: vi.fn().mockResolvedValue("secret"),
  // Accepting the default is what pressing Enter does
  confirm: vi.fn(
    async (opts: { initialValue?: boolean }) =>
      // @clack/prompts defaults confirm to true when initialValue is unset
      opts.initialValue ?? true,
  ),
}));

vi.mock("../config/loader.js", () => ({
  saveConfig: vi.fn((_name: string, config: unknown) => saved.push(config)),
}));
vi.mock("../memory/mcp-json.js", () => ({ writeMcpJson: vi.fn() }));
vi.mock("../memory/claude-md.js", () => ({ generateClaudeMd: vi.fn() }));

describe("runWizard", () => {
  it("leaves deploy and test disabled when defaults are accepted", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { runWizard } = await import("../config/wizard.js");

    await runWizard("demo", "/tmp/demo");

    expect(saved).toHaveLength(1);
    const config = ProjectConfigSchema.parse({
      ...(saved[0] as Record<string, unknown>),
      jira: {
        ...(saved[0] as { jira: Record<string, unknown> }).jira,
        assignees: ["me"],
      },
    });
    expect(config.deploy.enabled).toBe(false);
    expect(config.test.enabled).toBe(false);
    expect(config.github.autoMergeWithoutHumanApproval).toBe(false);
  });
});
