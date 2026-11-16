# Feature 12 — Plugin System

> Priority: Tier 3 (strategic) · Size: L · Sprint 7+

## Problem

jiraACP's extensibility is limited to shell-script hooks (5 hook points). Teams want to:
- Add custom stages (e.g., security scan, performance test)
- Integrate new notification channels (Discord, Microsoft Teams, email)
- Add project-specific pre/post processing logic
- Share reusable extensions with the community

The current hook system can't express rich logic, doesn't share state with the pipeline, and has no discovery/install mechanism.

## Solution

TypeScript-based plugin system inspired by OpenACP's proven architecture:
- Plugins are npm packages with a standard entry point
- Lifecycle hooks for setup/teardown
- Registration API for custom stages, notifiers, and middleware
- CLI for install/remove/list/create

## CLI

```bash
jiraACP plugin install <npm-package>       # install from npm
jiraACP plugin install ./local-plugin      # install from local path
jiraACP plugin remove <name>               # uninstall
jiraACP plugin list                        # list installed plugins
jiraACP plugin create <name>               # scaffold new plugin project
jiraACP plugin enable <name>               # enable disabled plugin
jiraACP plugin disable <name>              # disable without removing
```

## Plugin Structure

```
my-jiraacp-plugin/
  package.json          # name, version, "jiraacp-plugin" keyword
  dist/
    index.js            # default export: PluginDefinition
  src/
    index.ts
```

### Plugin Definition

```typescript
interface PluginDefinition {
  name: string;
  version: string;
  description: string;
  dependencies?: string[];                   // other plugin names (for boot order)

  setup(ctx: PluginContext): Promise<void>;
  teardown?(): Promise<void>;
}

interface PluginContext {
  // Register custom pipeline stage
  registerStage(stage: CustomStage): void;

  // Register notification adapter
  registerNotifier(adapter: NotificationAdapter): void;

  // Register middleware (wraps existing stage execution)
  registerMiddleware(hook: MiddlewareHook, fn: MiddlewareFn): void;

  // Access pipeline events (read-only)
  onEvent(type: string, handler: EventHandler): void;

  // Plugin-scoped storage
  storage: PluginStorage;

  // Plugin-scoped logger
  logger: Logger;

  // Read pipeline config (read-only)
  config: ReadonlyConfig;
}
```

### Custom Stage

```typescript
interface CustomStage {
  name: string;                              // e.g., "security-scan"
  displayName: string;                       // e.g., "Security Scan"
  position: { after: string };               // insert after which stage, e.g., "review"
  model: "haiku" | "sonnet" | "opus";
  optional: boolean;                         // skip if plugin disabled

  execute(context: StageContext): Promise<StageResult>;
}

// Example: security scan plugin
const securityScan: CustomStage = {
  name: "security-scan",
  displayName: "Security Scan",
  position: { after: "review" },
  model: "sonnet",
  optional: true,

  async execute(ctx) {
    const result = await ctx.runAgent(`
      Analyze the PR diff for security vulnerabilities.
      Focus on: injection, auth bypass, secrets exposure.
      Return JSON: { "vulnerabilities": [...], "severity": "low|medium|high|critical" }
    `);
    return { passed: result.severity !== "critical", data: result };
  },
};
```

### Middleware Hooks

```typescript
type MiddlewareHook =
  | "pipeline:before"        // before pipeline starts
  | "pipeline:after"         // after pipeline completes
  | "stage:before"           // before any stage
  | "stage:after"            // after any stage
  | "agent:before"           // before agent execution
  | "agent:after"            // after agent execution
  | "notification:before"    // before sending notification
  | "cost:check"             // on cost evaluation

type MiddlewareFn = (context: MiddlewareContext, next: () => Promise<void>) => Promise<void>;
```

## Architecture

### New files

| File | Purpose |
|------|---------|
| `src/plugin/loader.ts` | Discover and load plugins from `~/.jira-acp/plugins/` |
| `src/plugin/context.ts` | `PluginContext` implementation — scoped API for each plugin |
| `src/plugin/registry.ts` | Central registry for stages, notifiers, middleware |
| `src/plugin/lifecycle.ts` | Boot plugins in dependency order, manage setup/teardown |
| `src/plugin/storage.ts` | Per-plugin file-based storage in `~/.jira-acp/plugins/<name>/` |
| `src/commands/plugin.ts` | CLI handlers for plugin management |
| `src/plugin/template/` | Scaffold template for `jiraACP plugin create` |

### Modified files

| File | Change |
|------|--------|
| `src/cli.ts` | Register `plugin` command group |
| `src/pipeline/orchestrator.ts` | Support dynamic stage insertion from plugins |
| `src/commands/serve.ts` | Boot plugin lifecycle on server start |
| `src/config/schema.ts` | Add `plugins` config section |

### Plugin storage layout

```
~/.jira-acp/
  plugins/
    package.json                    # dependencies (installed plugins)
    node_modules/                   # plugin packages
    security-scan/                  # per-plugin storage
      settings.json
      data/
```

### Plugin boot sequence

```
1. Load ~/.jira-acp/plugins/package.json → get installed plugins
2. For each plugin: require(pluginPath).default → PluginDefinition
3. Topological sort by dependencies
4. For each plugin (in order):
   a. Create PluginContext (scoped logger, storage, config)
   b. Call plugin.setup(ctx)
   c. Register stages, notifiers, middleware from ctx
5. Pipeline now includes custom stages at registered positions
```

### Stage ordering with plugins

```
Built-in: 1-fetch → 2-analyze → 3-clarify → 4-code → 5-git → 6-review → 7-deploy → 8-test → 9-notify

With security-scan plugin (position: { after: "review" }):
  1-fetch → 2-analyze → 3-clarify → 4-code → 5-git → 6-review → 6.5-security-scan → 7-deploy → 8-test → 9-notify

With lint plugin (position: { after: "code" }):
  1-fetch → 2-analyze → 3-clarify → 4-code → 4.5-lint → 5-git → ...
```

## Config

```jsonc
{
  "plugins": {
    "enabled": true,                         // NEW — master switch
    "directory": "~/.jira-acp/plugins",      // NEW — default path
    "disabled": ["plugin-name"],             // NEW — disabled plugins (still installed)
    "settings": {                            // NEW — per-plugin config passthrough
      "security-scan": {
        "severityThreshold": "high"
      }
    }
  }
}
```

## Edge Cases

1. **Plugin setup() throws** → log error, skip plugin, continue boot. Notify user.
2. **Circular dependency between plugins** → detect in topo-sort, abort boot with error message.
3. **Plugin registers stage at same position** → resolve by plugin load order (first wins).
4. **Plugin breaks pipeline** → middleware error → catch, log, continue without that middleware.
5. **Plugin version mismatch** → check `engines.jiraacp` in plugin package.json → warn if incompatible.
6. **Uninstall while running** → wait for current run to complete, then unload.
7. **Plugin accesses internal APIs** → PluginContext is the only API surface. No backdoor access.
8. **No plugins installed** → `plugins.enabled: true` but empty → no overhead, pipeline unchanged.
9. **Plugin storage cleanup** → `plugin remove` deletes storage directory after confirmation.

## Example Plugins (future community)

| Plugin | Description |
|--------|-------------|
| `jiraacp-security-scan` | OWASP check via Claude agent between review and deploy |
| `jiraacp-discord-notifier` | Discord webhook notifications |
| `jiraacp-teams-notifier` | Microsoft Teams notifications |
| `jiraacp-sonarqube` | SonarQube integration for code quality gate |
| `jiraacp-confluence-docs` | Auto-generate Confluence page from ticket + PR |
| `jiraacp-linear-sync` | Sync pipeline status to Linear |

## Dependencies

- No new npm dependencies for core. Plugins manage their own deps.
- Plugin template uses `tsup` for build (same as main project).

## Test Plan

- [ ] Unit: `loader.ts` discovers and loads valid plugins
- [ ] Unit: `loader.ts` skips invalid/broken plugins with error log
- [ ] Unit: `lifecycle.ts` boots plugins in dependency order
- [ ] Unit: `lifecycle.ts` detects circular dependencies
- [ ] Unit: `registry.ts` registers custom stages at correct position
- [ ] Unit: `registry.ts` registers middleware hooks
- [ ] Unit: `context.ts` provides scoped logger and storage
- [ ] Unit: `storage.ts` read/write per-plugin data
- [ ] Unit: disabled plugins not loaded
- [ ] Unit: plugin setup error → skipped gracefully
- [ ] Unit: `plugin create` generates valid scaffold
- [ ] Integration: pipeline runs with custom stage inserted
- [ ] Integration: middleware intercepts stage execution
- [ ] Integration: `plugin install/remove/list` CLI commands work
