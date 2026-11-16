import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        // Entry points / CLI shells — not unit-testable
        "src/cli.ts",
        "src/mcp.ts",
        "src/index.ts",
        "src/config/wizard.ts",
        // CLI command handlers — need real TTY/process
        "src/commands/**",
        // Telegram: needs real Bot API / long-polling
        "src/integrations/telegram/bot.ts",
        "src/integrations/telegram/commands.ts",
        "src/integrations/telegram/human-loop.ts",
        "src/integrations/telegram/notifier.ts",
        "src/integrations/telegram/topic-manager.ts",
        // GitHub client — integration-level, needs real GH token
        "src/integrations/github/client.ts",
        // Pipeline orchestrator — integration-level (ties everything together)
        "src/pipeline/orchestrator.ts",
        // Claude AI runner — calls real AI API
        "src/pipeline/runner.ts",
        // Pino logger factory — trivial wrapper
        "src/utils/logger.ts",
        // Jira MCP tools — integration layer requiring env vars (like github/client.ts)
        "src/integrations/jira/tools.ts",
        // Pure TypeScript type definitions — no runtime code
        "src/pipeline/stages/types.ts",
      ],
    },
  },
});
