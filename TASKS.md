# TASKS.md — jiraACP Sprint 3

## Architecture-confirmed: true

## Sprint 3 scope

Implement the 10 remaining SPEC.md features absent from Sprint 1+2:
token cost tracking (`usage`), event log pretty-printer (`replay`), process suspension
(`pause`), clarification cancellation (`cancel-clarification`), config mutation commands
(`config set` / `config edit`), project management commands (`projects list/add/remove`),
pipeline lifecycle hooks, cost-limit enforcement, and append-only audit log.

All tasks follow established patterns: `StateManager` from `src/pipeline/state.ts`,
`loadConfig` / `listProjects` from `src/config/loader.ts`, `readLockData` from
`src/utils/lock.ts`, `spawnSafe` from `src/utils/process.ts`, `createLogger` from
`src/utils/logger.ts`. No `any`, explicit return types, `.js` ESM imports.

---

## Wave 1 — Standalone commands (no inter-task deps)

### TASK-001 — `jiraACP replay <ticketKey>`

- [x] Status: complete
- File: `src/commands/replay.ts` (new), `src/pipeline/state.ts` (add `getEvents` export), `src/cli.ts` (register command)
- Scope:
  - Add exported helper to `src/pipeline/state.ts`:
    ```typescript
    export function getEvents(runDir: string): PipelineEvent[]
    ```
    Reads `state.json`, returns parsed event array (same logic as `StateManager.load()` — extract and export it)
  - Export `replayRun(ticketKey: string, projectName: string): Promise<void>` from `src/commands/replay.ts`
  - Load events via `getEvents(getRunDir(projectName, ticketKey))`; exit 1 if file not found
  - Pretty-print each event chronologically using `picocolors`:
    - `STARTED` → cyan header with ticketKey + timestamp
    - `STAGE_STARTED` / `STAGE_COMPLETED` / `STAGE_SKIPPED` → stage badge + elapsed ms between STARTED and COMPLETED
    - `STAGE_FAILED` → red with error text
    - `CLARIFICATION_REQUESTED` → yellow bullet list of questions
    - `CLARIFICATION_RECEIVED` → green with answers preview (first 80 chars)
    - `PIPELINE_COMPLETED` → green success summary with total elapsed
    - `PIPELINE_ABORTED` → red with reason
  - Read-only: no writes, no side effects, no Telegram calls
  - Register in `src/cli.ts`:
    ```
    jiraACP replay <ticketKey> [--project <name>]
    ```
- Deps: none
- Acceptance:
  ```
  jiraACP replay PROJ-123 --project my-saas
  # prints all events in order, coloured, with timestamps
  # exits 0 for completed or in-progress runs
  # exits 1 with error message if PROJ-123 has no state file
  ```

---

### TASK-002 — `jiraACP pause <ticketKey>`

- [x] Status: complete
- File: `src/commands/pause.ts` (new), `src/cli.ts` (register command)
- Scope:
  - Export `pausePipeline(ticketKey: string, projectName: string): Promise<void>`
  - Read lock via `readLockData(getLockPath(projectName, ticketKey))`
  - If no lock file: `process.stderr.write('No running pipeline found for <ticketKey>\n')`, exit 1
  - Check `lockData.pid` is alive using `process.kill(pid, 0)` inside try/catch; if ESRCH: print error, exit 1
  - Send `SIGSTOP` to `lockData.pid` via `process.kill(pid, 'SIGSTOP')`
  - Handle ESRCH on SIGSTOP (race condition — process died between check and signal): print warning, exit 0
  - Print: `✓ Pipeline PROJ-123 paused (PID <pid>). Resume with: jiraACP resume PROJ-123`
  - Register in `src/cli.ts`:
    ```
    jiraACP pause <ticketKey> [--project <name>]
    ```
- Deps: none
- Acceptance:
  ```
  # Start a long pipeline, then in another terminal:
  jiraACP pause PROJ-123 --project my-saas
  # process suspended (SIGSTOP), prints confirmation
  jiraACP resume PROJ-123 --project my-saas
  # pipeline continues from last checkpoint
  ```

---

### TASK-003 — `jiraACP cancel-clarification <ticketKey>`

- [x] Status: complete
- File: `src/commands/cancel-clarification.ts` (new), `src/cli.ts` (register command)
- Scope:
  - Export `cancelClarification(ticketKey: string, projectName: string): Promise<void>`
  - Pending clarifications file: `PENDING_FILE = path.join(os.homedir(), '.jira-acp', 'pending-clarifications.json')`
  - Read file (if missing or empty array: treat as no entry); filter out object where `.ticketKey === ticketKey`; write back
  - If no matching entry found: print `No pending clarification found for <ticketKey>`, exit 0
  - Emit `CLARIFICATION_RECEIVED` event with `answers: 'CANCELLED'` into the run's `StateManager`
    so state reflects the cancellation for dead-process scenarios
  - Print: `✓ Clarification for <ticketKey> cancelled`
  - Register in `src/cli.ts`:
    ```
    jiraACP cancel-clarification <ticketKey> [--project <name>]
    ```
- Deps: none
- Acceptance:
  ```
  # With a pending entry in pending-clarifications.json for PROJ-123:
  jiraACP cancel-clarification PROJ-123 --project my-saas
  # pending-clarifications.json no longer has PROJ-123
  # state.json has CLARIFICATION_RECEIVED { answers: "CANCELLED" }

  # Without a pending entry:
  jiraACP cancel-clarification PROJ-456 --project my-saas
  # "No pending clarification found for PROJ-456", exit 0
  ```

---

### TASK-004 — `jiraACP config set <key> <value>`

- [x] Status: complete
- File: `src/commands/config-set.ts` (new), `src/cli.ts` (extend `config` command group)
- Scope:
  - Export `configSet(projectName: string, key: string, rawValue: string): Promise<void>`
  - Config file path: `path.join(os.homedir(), '.jira-acp', 'projects', projectName + '.json')`
  - Exit 1 with message if file not found
  - Read raw JSON with `JSON.parse(fs.readFileSync(...))` — do NOT run through zod loader
    (preserves `"env:VAR_NAME"` references and unrecognised keys)
  - Parse `rawValue`:
    - Try `JSON.parse(rawValue)` first; if that throws, treat as plain string
  - Helper (unexported): `setDotPath(obj: Record<string, unknown>, dotKey: string, value: unknown): void`
    — splits on `.`, traverses and creates nested objects as needed, sets leaf
  - Write back with `JSON.stringify(obj, null, 2) + '\n'`
  - Validate mutated config with zod schema from `src/config/schema.ts`; if invalid:
    restore backup bytes and exit 1 with first validation error message
  - Print: `✓ Set <key> = <rawValue> in project <projectName>`
  - Register in `src/cli.ts` under `config` command group:
    ```
    jiraACP config set <key> <value> [--project <name>]
    ```
- Deps: none
- Acceptance:
  ```
  jiraACP config set pipeline.maxConcurrentRuns 3 --project my-saas
  jiraACP config get pipeline.maxConcurrentRuns --project my-saas
  # prints: 3

  jiraACP config set github.autoMergeStrategy squash --project my-saas
  jiraACP config get github.autoMergeStrategy --project my-saas
  # prints: "squash"
  ```

---

### TASK-005 — `jiraACP config edit`

- [x] Status: complete
- File: `src/commands/config-edit.ts` (new), `src/cli.ts` (extend `config` command group)
- Scope:
  - Export `configEdit(projectName: string): Promise<void>`
  - Config file path: `path.join(os.homedir(), '.jira-acp', 'projects', projectName + '.json')`
  - Exit 1 with message if file not found
  - Determine editor: `process.env['EDITOR'] ?? process.env['VISUAL'] ?? 'nano'`
  - Open via `spawnSafe` from `src/utils/process.ts` with `stdio: 'inherit'` so user can type:
    ```typescript
    await spawnSafe(editor, [configPath], { stdio: 'inherit' })
    ```
  - After editor exits, validate with zod schema from `src/config/schema.ts`; if invalid:
    log each error with pino at `warn` level and print:
    `Warning: config may be invalid — run: jiraACP doctor`
  - On valid: print `✓ Config saved`
  - Register in `src/cli.ts` under `config` command group:
    ```
    jiraACP config edit [--project <name>]
    ```
- Deps: none
- Acceptance:
  ```
  EDITOR=nano jiraACP config edit --project my-saas
  # opens nano with the JSON config
  # on save+exit: validates and prints result
  ```

---

### TASK-006 — `jiraACP projects list/add/remove`

- [x] Status: complete
- File: `src/commands/projects.ts` (new), `src/config/defaults.ts` (add `getDefaultConfigTemplate`), `src/cli.ts` (register `projects` command group)
- Scope:
  - `PROJECTS_DIR = path.join(os.homedir(), '.jira-acp', 'projects')`
  - `projectsList(): void`
    - `fs.readdirSync(PROJECTS_DIR).filter(f => f.endsWith('.json'))`; if none: `No projects configured. Run: jiraACP init`
    - For each, read and parse JSON, print row: `<name>  <jira.projectKey>  <workspace.rootDir>`
    - Use `picocolors` for column alignment (pad with spaces)
  - `projectsAdd(name: string): Promise<void>`
    - Exit 1 if `<PROJECTS_DIR>/<name>.json` already exists
    - Call `getDefaultConfigTemplate(name): Record<string, unknown>` from `src/config/defaults.ts`
      — returns the minimal valid config skeleton with placeholder strings like `"env:JIRA_..."`;
      update `defaults.ts` to export this function
    - Write file with `JSON.stringify(template, null, 2) + '\n'`
    - Print: `✓ Created ~/.jira-acp/projects/<name>.json — fill in credentials before running`
  - `projectsRemove(name: string): Promise<void>`
    - Exit 1 if file not found
    - Prompt: `import { confirm } from '@clack/prompts'` then `await confirm({ message: \`Delete project '${name}'? This is irreversible.\` })`
    - On `true`: `fs.unlinkSync(configPath)`; print `✓ Project '<name>' removed`
    - On `false` or cancel: print `Cancelled.`, exit 0
  - Register in `src/cli.ts`:
    ```
    jiraACP projects list
    jiraACP projects add <name>
    jiraACP projects remove <name>
    ```
- Deps: none
- Acceptance:
  ```
  jiraACP projects list          # shows table
  jiraACP projects add new-proj  # creates file, prints path
  jiraACP projects remove new-proj  # prompts, deletes on confirm
  ```

---

### TASK-007 — `jiraACP usage [--month YYYY-MM]`

- [x] Status: complete
- File: `src/commands/usage.ts` (new), `src/utils/pricing.ts` (new), `src/cli.ts` (register command)
- Scope:
  - Create `src/utils/pricing.ts`:
    ```typescript
    export interface ModelPricing {
      inputPer1M: number
      outputPer1M: number
    }

    export const MODEL_PRICING: Record<string, ModelPricing> = {
      'claude-haiku-4':   { inputPer1M: 0.25,  outputPer1M: 1.25 },
      'claude-sonnet-4':  { inputPer1M: 3.00,  outputPer1M: 15.00 },
      'claude-opus-4':    { inputPer1M: 15.00, outputPer1M: 75.00 },
    }

    export function estimateCostUsd(
      inputTokens: number,
      outputTokens: number,
      model: string,
    ): number
    ```
    — looks up `MODEL_PRICING[model]`, falls back to sonnet pricing if unknown
  - Export `showUsage(opts: { month?: string; project?: string; verbose?: boolean }): Promise<void>`
  - Scan `~/.jira-acp/runs/<project>/<ticketKey>/state.json` recursively
  - For each state file: load events, find `STARTED` event to get month, filter by `--month` if provided
  - Extract `STAGE_COMPLETED` events where `(event.output as Record<string, unknown>).tokenUsage` exists
    with shape `{ inputTokens: number; outputTokens: number; model: string }`
  - Aggregate per project: summed tokens + `estimateCostUsd` from `src/utils/pricing.ts`
  - Print table: `Project | Runs | Input tokens | Output tokens | Est. cost USD`
  - With `--verbose`: also print per-stage breakdown under each project row
  - Register in `src/cli.ts`:
    ```
    jiraACP usage [--month YYYY-MM] [--project <name>] [--verbose]
    ```
- Deps: none (reads existing state files; graceful degradation if `tokenUsage` absent)
- Acceptance:
  ```
  jiraACP usage
  # prints cost table for all projects, all time

  jiraACP usage --month 2025-04 --project my-saas
  # filtered to April 2025 runs for my-saas only

  jiraACP usage --verbose
  # includes per-stage token breakdown
  ```

---

## Wave 2 — Features requiring orchestrator/stage integration (depends on Wave 1)

### TASK-008 — Pipeline hooks (`beforePipeline`, `beforeCode`, `afterCode`, `afterDeploy`, `afterPipeline`)

- [x] Status: complete
- File: `src/pipeline/hooks.ts` (new), `src/pipeline/orchestrator.ts` (inject hook calls)
- Scope:
  - Create `src/pipeline/hooks.ts`:
    ```typescript
    import type { Logger } from 'pino'

    export type HookName =
      | 'beforePipeline'
      | 'beforeCode'
      | 'afterCode'
      | 'afterDeploy'
      | 'afterPipeline'

    export class HookError extends Error {
      constructor(
        public readonly hookName: HookName,
        public readonly exitCode: number,
      ) {
        super(`Hook '${hookName}' failed with exit code ${exitCode}`)
        this.name = 'HookError'
      }
    }

    export async function runHook(
      name: HookName,
      command: string | undefined,
      ctx: { ticketKey: string; logger: Logger },
    ): Promise<void>
    ```
  - If `command` is undefined or empty string: return (no-op)
  - Split: `const [bin, ...args] = command.trim().split(/\s+/)`
  - Execute: `await spawnSafe(bin, args, { stdio: 'inherit', env: buildMinimalEnv({ JIRA_ACP_TICKET: ctx.ticketKey }) })`
  - If non-zero exit: throw `HookError(name, exitCode)`
  - Log hook start (`info`) and completion (`info`) or failure (`error`) with pino
  - Inject into `src/pipeline/orchestrator.ts`:
    - `beforePipeline` — before the stage loop, after lock acquired
    - `beforeCode` — before stage 4 `run()` call (check `stage.id === 'code'`)
    - `afterCode` — after stage 4 `STAGE_COMPLETED` event emitted
    - `afterDeploy` — after stage 7 `STAGE_COMPLETED` event emitted
    - `afterPipeline` — in `finally` block (runs even on abort/failure)
  - Orchestrator wraps `HookError` → emits `PIPELINE_ABORTED` with the error message before re-throwing
  - Read commands from `config.pipeline.hooks[name] as string | undefined`
- Deps: Wave 1 merged (ensures orchestrator structure is stable before patching)
- Acceptance:
  ```json
  {
    "pipeline": {
      "hooks": {
        "beforeCode": "scripts/before-code.sh",
        "afterPipeline": "scripts/notify-slack.sh"
      }
    }
  }
  ```
  ```
  jiraACP run PROJ-123 --project my-saas
  # scripts/before-code.sh runs before stage 4
  # scripts/notify-slack.sh runs in finally block regardless of outcome
  # If before-code.sh exits 1: pipeline aborts with HookError message
  ```

---

### TASK-009 — Cost limit enforcement (`maxCostUsdPerRun`)

- [x] Status: complete
- File: `src/pipeline/cost-guard.ts` (new), `src/pipeline/orchestrator.ts` (call guard between stages)
- Scope:
  - Create `src/pipeline/cost-guard.ts`:
    ```typescript
    import type { TelegramNotifier } from '../integrations/telegram/notifier.js'

    export async function checkCostLimit(opts: {
      runDir: string
      maxCostUsd: number
      telegram: TelegramNotifier
      ticketKey: string
    }): Promise<'continue' | 'abort'>
    ```
  - Implementation:
    1. Call `getEvents(opts.runDir)` (exported from `src/pipeline/state.ts` in TASK-001)
    2. Collect `tokenUsage` from each `STAGE_COMPLETED` event's `output` field
       (guard with `typeof output === 'object' && output !== null && 'tokenUsage' in output`)
    3. Sum cost using `estimateCostUsd` from `src/utils/pricing.ts` (from TASK-007)
    4. If `totalCost >= opts.maxCostUsd`:
       - `await opts.telegram.send(...)` with message:
         `[jiraACP] Cost limit reached ($<total> / $<max>) for <ticketKey>. Aborting.`
       - return `'abort'`
    5. If `totalCost >= 0.8 * opts.maxCostUsd`:
       - `await opts.telegram.send(...)` warning about 80% threshold
       - return `'continue'`
    6. Otherwise: return `'continue'`
  - Inject into `src/pipeline/orchestrator.ts`: after each `STAGE_COMPLETED` event is emitted,
    if `config.pipeline.maxCostUsdPerRun` is defined and > 0:
    call `checkCostLimit(...)`; if `'abort'`: emit `PIPELINE_ABORTED` and throw
  - Only active when `maxCostUsdPerRun` is defined
- Deps: TASK-001 (`getEvents` export), TASK-007 (`src/utils/pricing.ts`)
- Acceptance:
  ```json
  { "pipeline": { "maxCostUsdPerRun": 0.05 } }
  ```
  ```
  # When cumulative cost after any stage exceeds $0.05:
  # Telegram message sent ("Cost limit reached")
  # PIPELINE_ABORTED emitted in state.json
  # jiraACP run exits with code 1

  # When cost crosses 80% ($0.04):
  # Telegram warning sent, pipeline continues
  ```

---

### TASK-010 — Append-only audit log (`~/.jira-acp/audit.log`)

- [x] Status: complete
- File: `src/utils/audit.ts` (new); call sites in `src/pipeline/stages/9-notify.ts`, `src/pipeline/stages/5-git.ts`, `src/pipeline/stages/6-review.ts`, `src/integrations/telegram/notifier.ts`
- Scope:
  - Create `src/utils/audit.ts`:
    ```typescript
    export type AuditAction =
      | 'JIRA_STATUS_CHANGED'
      | 'JIRA_COMMENT_ADDED'
      | 'JIRA_REASSIGNED'
      | 'GITHUB_PR_CREATED'
      | 'GITHUB_PR_MERGED'
      | 'TELEGRAM_MESSAGE_SENT'

    export interface AuditEntry {
      timestamp: string
      project: string
      ticketKey: string
      action: AuditAction
      detail: Record<string, string | number | boolean>
    }

    export function writeAuditEntry(
      entry: Omit<AuditEntry, 'timestamp'>,
    ): void
    ```
  - `AUDIT_FILE = path.join(os.homedir(), '.jira-acp', 'audit.log')`
  - `writeAuditEntry`: `fs.appendFileSync(AUDIT_FILE, JSON.stringify({ ...entry, timestamp }) + '\n')`
  - Token redaction: before writing, iterate `entry.detail` values; if a string value matches
    `/^[A-Za-z0-9\-_]{31,}$/` replace it with `'<redacted>'`
  - Add call sites (each must pass `project` and `ticketKey` from pipeline `ctx`):
    - `src/pipeline/stages/9-notify.ts` — after `jira.transitionTicket(...)` resolves → `JIRA_STATUS_CHANGED` with `{ toStatus: string }`
    - `src/pipeline/stages/9-notify.ts` — after `jira.addComment(...)` resolves → `JIRA_COMMENT_ADDED` with `{ commentLength: number }`
    - `src/pipeline/stages/9-notify.ts` — after `jira.reassign(...)` resolves → `JIRA_REASSIGNED` with `{ assignee: string }`
    - `src/pipeline/stages/5-git.ts` — after `github.createPR(...)` resolves → `GITHUB_PR_CREATED` with `{ prNumber: number, url: string }`
    - `src/pipeline/stages/6-review.ts` — after `github.mergePR(...)` resolves → `GITHUB_PR_MERGED` with `{ prNumber: number, strategy: string }`
    - `src/integrations/telegram/notifier.ts` — after each `bot.api.sendMessage(...)` resolves → `TELEGRAM_MESSAGE_SENT` with `{ messageId: number }`
  - `writeAuditEntry` is synchronous (append-only, no async needed); wrap each call site in
    try/catch to prevent audit failure from breaking the pipeline
- Deps: Wave 1 merged (code review of stages must be stable before adding call sites)
- Acceptance:
  ```
  jiraACP run PROJ-123 --project my-saas   # complete run to stage 9
  cat ~/.jira-acp/audit.log
  # One JSON line per external mutation, e.g.:
  # {"timestamp":"2025-04-05T09:00:00.000Z","project":"my-saas","ticketKey":"PROJ-123","action":"GITHUB_PR_CREATED","detail":{"prNumber":42,"url":"https://github.com/.../pull/42"}}
  # {"timestamp":"...","action":"TELEGRAM_MESSAGE_SENT","detail":{"messageId":999}}
  # No token strings (> 30 alphanum chars) appear anywhere in the file
  ```

---

## Definition of Done (all tasks)

- `npm run build` exits 0 with zero TypeScript errors
- No `any` — use `unknown` + type guard where dynamic types are needed
- All new exports have explicit return types
- All imports use `.js` extension (ESM)
- No `console.log` in production paths — pino logger only
- All subprocess calls use `spawnSafe` (never `exec`)
- New commands registered in `src/cli.ts` with `--project` option following existing pattern

---

## Sprint 4 — Gap Fills & Hardening (2026-04-18)

All tasks follow established patterns: `StateManager` from `src/pipeline/state.ts`,
`spawnSafe` from `src/utils/process.ts`, `createLogger` from `src/utils/logger.ts`,
config schema via Zod in `src/config/schema.ts` (new fields use `.default()` or `.optional()`).
No `any`, explicit return types, `.js` ESM imports.

---

## Wave 1 — Independent XS tasks (no inter-task deps)

### TASK-013 — Memory file mutex for concurrent review agents

- [ ] Status: pending
- File: `src/utils/file-lock.ts` (new), `src/memory/context-builder.ts` (add `writeReviewAgentOutput`, `mergeReviewOutputs`), `src/pipeline/stages/6-review.ts` (isolated agent outputs + merge step)
- Scope:
  - Create `src/utils/file-lock.ts` with generic file-level lock using `O_EXCL` pattern (mirrors `src/utils/lock.ts`):
    ```typescript
    export class FileLockTimeout extends Error {
      constructor(public readonly filePath: string) {
        super(`File lock timeout: ${filePath}`)
        this.name = 'FileLockTimeout'
      }
    }

    export async function withFileLock<T>(
      filePath: string,
      fn: () => Promise<T>,
      timeout?: number,
    ): Promise<T>
    ```
    - Lock file: `${filePath}.lock` created via `fs.writeFileSync(lockPath, ..., { flag: 'wx' })` (O_EXCL)
    - Default timeout: 10_000ms; poll every 200ms with `setTimeout` loop
    - On timeout: throw `FileLockTimeout`
    - Stale lock detection: if lock file exists and `mtime` > 60s ago, remove it and retry
    - Always release in `finally` block via `fs.unlinkSync(lockPath)` wrapped in try/catch
  - Modify `src/memory/context-builder.ts` — add two new exports:
    ```typescript
    export function writeReviewAgentOutput(
      memoryDir: string,
      agentId: 'logic' | 'quality',
      raw: string,
    ): void
    ```
    - Writes to `memory/review-logic.md` or `memory/review-quality.md` (isolated, no race)
    ```typescript
    export function mergeReviewOutputs(memoryDir: string): string
    ```
    - Reads both agent files, concatenates into `review-feedback.md`
    - Called sequentially after both agents complete
  - Modify `src/pipeline/stages/6-review.ts`:
    - After `runAgentsParallel()` returns `[logicRaw, qualityRaw]`:
      call `writeReviewAgentOutput(memoryDir, 'logic', logicRaw)` and
      `writeReviewAgentOutput(memoryDir, 'quality', qualityRaw)` (isolated files, no contention)
    - Then call `mergeReviewOutputs(memoryDir)` sequentially before parsing issues
    - Existing `writeReviewFeedback()` call remains unchanged (writes the final merged result)
  - The `withFileLock` utility is generic — available for any future parallel writes outside review
- Deps: none
- Acceptance:
  ```
  # Run a pipeline with review stage — two agents write in parallel:
  jiraACP run PROJ-123 --project my-saas
  # ~/.jira-acp/runs/my-saas/PROJ-123/memory/ contains:
  #   review-logic.md      (agent 1 raw output)
  #   review-quality.md    (agent 2 raw output)
  #   review-feedback.md   (merged, structured result)
  # No file corruption even under concurrent writes

  # withFileLock timeout test:
  # Acquire lock on a file, attempt second lock → throws FileLockTimeout after 10s
  # Stale lock (> 60s mtime) → auto-removed on next acquire attempt
  ```

---

### TASK-014 — Analyze stage fallback on JSON parse failure

- [ ] Status: pending
- File: `src/pipeline/stages/2-analyze.ts` (retry + fallback logic), `src/pipeline/state.ts` (add `ANALYZE_PARSE_FALLBACK` event type), `src/config/schema.ts` (add `analyzeFallbackScore` field)
- Scope:
  - Add `ANALYZE_PARSE_FALLBACK` to the `PipelineEvent` union in `src/pipeline/state.ts`:
    ```typescript
    | { type: 'ANALYZE_PARSE_FALLBACK'; rawSnippet: string; timestamp: string }
    ```
    - Also update `applyEvent()` — default case already returns state unchanged, so no functional change needed
  - Add `analyzeFallbackScore` to `pipeline` section in `src/config/schema.ts`:
    ```typescript
    analyzeFallbackScore: z.number().min(0).max(1).default(0.5),
    ```
  - Rewrite JSON extraction in `src/pipeline/stages/2-analyze.ts`:
    1. First attempt: current `raw.match(/\{[\s\S]*\}/)` + `JSON.parse`
    2. If parse fails → retry agent call with explicit format instruction appended:
       ```
       IMPORTANT: Return ONLY valid JSON: {"score": 0.7, "missing": [...], "questions": [...]}
       ```
    3. If retry parse also fails → attempt regex score extraction:
       `const scoreMatch = raw.match(/"score"\s*:\s*([\d.]+)/)`
       - If found: use extracted score with `missing: [], questions: []`
    4. If all extraction fails → emit `ANALYZE_PARSE_FALLBACK` event via `ctx.state.emit(...)` with
       `rawSnippet: raw.slice(0, 500)`
    5. Send Telegram warning: `await ctx.telegram.send('...')` with fallback notification
    6. Return `{ score: fallbackScore, missing: [], questions: [], needsClarification: fallbackScore < threshold }`
       where `fallbackScore = config.pipeline.analyzeFallbackScore ?? 0.5`
  - The existing happy path (first parse succeeds) is unchanged — no performance impact
  - Key change: default score shifts from `0` (always triggers clarify) to `0.5` (configurable)
- Deps: none
- Acceptance:
  ```
  # Happy path — valid JSON on first try:
  # No retry, no fallback, no event. Score used as-is.

  # First parse fails, retry succeeds:
  # Uses retry result. No ANALYZE_PARSE_FALLBACK event.

  # Both parses fail, regex extracts score:
  # Uses extracted score. No ANALYZE_PARSE_FALLBACK event.

  # All extraction fails:
  jiraACP run PROJ-123 --project my-saas
  # state.json contains ANALYZE_PARSE_FALLBACK event with rawSnippet
  # Telegram receives warning message about parse fallback
  # Pipeline continues with score 0.5 (default)
  # If clarityThreshold is 0.7 → clarify stage triggers (0.5 < 0.7)
  # If clarityThreshold is 0.4 → clarify stage skips (0.5 >= 0.4)

  # Custom fallback score:
  # config: { "pipeline": { "analyzeFallbackScore": 0.8 } }
  # On double failure → score 0.8, likely skips clarify
  ```

---

### TASK-015 — Review approval reminder pings

- [ ] Status: pending
- File: `src/integrations/telegram/human-loop.ts` (add reminder loop in `requestApproval`), `src/config/schema.ts` (add `reminderInterval`, `maxReminders` fields), `src/pipeline/state.ts` (add `APPROVAL_REMINDER_SENT` event type)
- Scope:
  - Add `APPROVAL_REMINDER_SENT` to the `PipelineEvent` union in `src/pipeline/state.ts`:
    ```typescript
    | { type: 'APPROVAL_REMINDER_SENT'; count: number; timestamp: string }
    ```
  - Add fields to `telegram.humanInTheLoop` section in `src/config/schema.ts`:
    ```typescript
    reminderIntervalMs: z.number().default(1_800_000),  // 30min
    maxReminders: z.number().default(3),
    ```
  - Modify `requestApproval()` in `src/integrations/telegram/human-loop.ts`:
    - Accept two new optional fields in the `opts` parameter:
      ```typescript
      opts: {
        timeoutMs: number;
        onTimeout: ApprovalTimeoutAction;
        topicId?: number;
        reminderIntervalMs?: number;  // NEW
        maxReminders?: number;         // NEW
      }
      ```
    - Replace the single `setTimeout` timeout with a `setInterval`-based reminder loop:
      ```typescript
      const interval = opts.reminderIntervalMs ?? 1_800_000
      const maxR = opts.maxReminders ?? 3
      let reminderCount = 0

      const reminderTimer = setInterval(async () => {
        if (!pendingApprovals.has(ticketKey)) {
          clearInterval(reminderTimer)
          return
        }
        reminderCount++
        if (reminderCount > maxR) {
          clearInterval(reminderTimer)
          return
        }

        const elapsed = Date.now() - Date.parse(entry.createdAt)
        const remaining = opts.timeoutMs - elapsed
        const elapsedStr = formatDuration(elapsed)
        const remainingStr = formatDuration(remaining)

        const reminderText = [
          `🔔 Reminder (${reminderCount}/${maxR}): <b>${ticketKey}</b> review approval pending`,
          '',
          `${issues.filter(i => i.severity === 'major').length} major issues found — waiting for your decision.`,
          `⏱️ Elapsed: ${elapsedStr} — auto-${opts.onTimeout} in ${remainingStr}`,
        ].join('\n')

        await bot.api.sendMessage(chatId, reminderText, {
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [[ /* same approve/reject buttons */ ]] },
          ...threadOpts,
        }).catch(() => undefined)  // swallow Telegram rate-limit errors
      }, interval)
      ```
    - Clear `reminderTimer` when approval/rejection resolves (in the callback handler and timeout handler)
    - Add unexported helper:
      ```typescript
      function formatDuration(ms: number): string {
        const mins = Math.floor(ms / 60_000)
        const hours = Math.floor(mins / 60)
        const remainMins = mins % 60
        return hours > 0 ? `${hours}h ${remainMins}m` : `${mins}m`
      }
      ```
  - Modify call site in `src/pipeline/stages/6-review.ts`:
    - Pass `reminderIntervalMs` and `maxReminders` from `config.telegram.humanInTheLoop` to `requestApproval()`:
      ```typescript
      await requestApproval(
        config.telegram.botToken,
        config.telegram.chatId,
        ticketKey,
        issues,
        {
          timeoutMs: hil?.reviewApprovalTimeoutMs ?? 86_400_000,
          onTimeout: hil?.reviewApprovalTimeoutAction ?? 'abort',
          topicId: config.telegram.topicId,
          reminderIntervalMs: hil?.reminderIntervalMs,
          maxReminders: hil?.maxReminders,
        },
      )
      ```
  - Note: `APPROVAL_REMINDER_SENT` event emission requires `StateManager` access — since `requestApproval` is in the integration layer (no access to `StateManager`), the event emission is done in `6-review.ts` by wrapping `requestApproval` or by returning reminder count. Alternative: pass an `onReminder` callback to `requestApproval` that the stage uses to emit the event.
    ```typescript
    // In requestApproval opts:
    onReminder?: (count: number) => void

    // In 6-review.ts call:
    onReminder: (count) => ctx.state.emit({ type: 'APPROVAL_REMINDER_SENT', count }),
    ```
- Deps: none
- Acceptance:
  ```json
  {
    "telegram": {
      "humanInTheLoop": {
        "reviewApprovalTimeoutMs": 3600000,
        "reminderIntervalMs": 900000,
        "maxReminders": 2
      }
    }
  }
  ```
  ```
  jiraACP run PROJ-123 --project my-saas
  # Review finds major issues → approval request sent
  # After 15min: reminder 1/2 sent with elapsed time + countdown
  # After 30min: reminder 2/2 sent
  # After 60min: timeout → abort (or merge-anyway per config)
  # state.json has APPROVAL_REMINDER_SENT events with count 1, 2

  # User approves at 10min → no reminders sent, timer cleared
  # maxReminders: 0 → no reminders ever sent, timeout action applies directly
  # reminderIntervalMs > reviewApprovalTimeoutMs → no reminders (interval never fires)
  ```

---

## Wave 2 — Features requiring stage integration (may depend on Wave 1 or existing code)

### TASK-011 — Auto-rollback on deploy/test failure

- [ ] Status: pending
- File: `src/pipeline/rollback.ts` (new), `src/pipeline/stages/7-deploy.ts` (call rollback on health-check failure), `src/pipeline/stages/8-test.ts` (call rollback on test failure), `src/pipeline/state.ts` (add `DEPLOY_ROLLED_BACK` event type), `src/config/schema.ts` (add `rollbackTimeoutMs` field), `src/integrations/telegram/notifier.ts` (add `notifyRollback` method)
- Scope:
  - Add `DEPLOY_ROLLED_BACK` to the `PipelineEvent` union in `src/pipeline/state.ts`:
    ```typescript
    | {
        type: 'DEPLOY_ROLLED_BACK';
        trigger: 'deploy' | 'test';
        success: boolean;
        durationMs: number;
        timestamp: string;
      }
    ```
    - Update `applyEvent()`: no state mutation needed (informational event), default case handles it
  - Add `rollbackTimeoutMs` to `deploy` section in `src/config/schema.ts`:
    ```typescript
    rollbackTimeoutMs: z.number().default(60_000),
    ```
    - `rollbackCommand` already exists in schema as `z.string().optional()` — no change needed
  - Create `src/pipeline/rollback.ts`:
    ```typescript
    import { spawnSafe, buildMinimalEnv } from '../utils/process.js'
    import type { ProjectConfig } from '../config/schema.js'
    import type { Logger } from 'pino'

    export interface RollbackResult {
      success: boolean
      stdout: string
      stderr: string
      durationMs: number
    }

    export async function executeRollback(
      config: ProjectConfig,
      context: {
        ticketKey: string
        branchName: string | null
        prUrl: string | null
        logger: Logger
      },
    ): Promise<RollbackResult>
    ```
    - If `config.deploy.rollbackCommand` is undefined or empty: throw `Error('No rollbackCommand configured')`
    - Execute via `spawnSafe(config.deploy.rollbackCommand, [], { ... })`:
      - `cwd`: `config.workspace.rootDir`
      - `env`: `buildMinimalEnv({ ...config.deploy.env, JIRA_ACP_TICKET: context.ticketKey, BRANCH: context.branchName ?? '', PR_URL: context.prUrl ?? '' })`
      - `timeoutMs`: `config.deploy.rollbackTimeoutMs ?? 60_000`
    - Return `{ success: result.exitCode === 0, stdout: result.stdout, stderr: result.stderr, durationMs }`
    - Log rollback start (`info`) and result (`info` on success, `error` on failure) via `context.logger`
  - Add `notifyRollback` to `TelegramNotifier` interface and implementation in `src/integrations/telegram/notifier.ts`:
    ```typescript
    notifyRollback(ticketKey: string, opts: {
      trigger: 'deploy' | 'test';
      success: boolean;
      error: string;
    }): Promise<void>
    ```
    - On rollback success: send `"⚠️ <b>${ticketKey}</b> — Deploy failed, rolled back ✓\nTrigger: ${trigger}\nError: ${error}"`
    - On rollback failure: send `"🚨 <b>${ticketKey}</b> — Deploy failed, rollback ALSO failed ⚠️\nTrigger: ${trigger}\nError: ${error}"`
  - Modify `src/pipeline/stages/7-deploy.ts`:
    - Import `executeRollback` from `../rollback.js`
    - In the deploy failure path (after health check fails), before throwing:
      ```typescript
      if (config.deploy.rollbackCommand) {
        const rollbackResult = await executeRollback(config, {
          ticketKey,
          branchName: ctx.state.current.branchName,
          prUrl: null,
          logger: ctx.logger,
        })
        ctx.state.emit({
          type: 'DEPLOY_ROLLED_BACK',
          trigger: 'deploy',
          success: rollbackResult.success,
          durationMs: rollbackResult.durationMs,
        })
        await ctx.telegram.notifyRollback(ticketKey, {
          trigger: 'deploy',
          success: rollbackResult.success,
          error: deployError.message,
        })
      }
      ```
    - Wrap `executeRollback` call in try/catch — if rollback itself throws (e.g. timeout), log error and emit `DEPLOY_ROLLED_BACK` with `success: false`
    - In dry-run mode: log `"Would execute rollback: ${config.deploy.rollbackCommand}"` but do not run
  - Modify `src/pipeline/stages/8-test.ts`:
    - Same pattern as stage 7: on final test failure (after all retries), if `config.pipeline.failOnTestFailure` is true and `config.deploy.rollbackCommand` is configured:
      ```typescript
      if (failOnTest && config.deploy.rollbackCommand) {
        // Same rollback logic as stage 7
      }
      ```
    - Trigger field: `'test'` instead of `'deploy'`
- Deps: none (rollbackCommand already in schema; executeRollback is self-contained)
- Acceptance:
  ```json
  {
    "deploy": {
      "enabled": true,
      "command": "deploy.sh",
      "rollbackCommand": "rollback.sh",
      "healthCheckUrl": "https://staging.example.com/health",
      "rollbackTimeoutMs": 30000
    }
  }
  ```
  ```
  # Health check fails after deploy:
  jiraACP run PROJ-123 --project my-saas
  # rollback.sh executed with JIRA_ACP_TICKET=PROJ-123 in env
  # state.json has DEPLOY_ROLLED_BACK { trigger: "deploy", success: true, durationMs: 1234 }
  # Telegram: "Deploy failed, rolled back ✓"
  # Pipeline aborts after rollback

  # Test failure with rollback:
  # stage 8 fails → rollback.sh executed → DEPLOY_ROLLED_BACK { trigger: "test" }

  # No rollbackCommand configured:
  # Deploy fails → abort as before, no rollback attempted

  # Rollback itself fails (exit 1 or timeout):
  # DEPLOY_ROLLED_BACK { success: false }
  # Telegram: "Deploy failed, rollback ALSO failed ⚠️"

  # Dry-run:
  jiraACP run PROJ-123 --project my-saas --dry-run
  # Logs "Would execute rollback" — does NOT run rollback.sh
  ```

---

### TASK-012 — CI status polling with exponential backoff

- [ ] Status: pending
- File: `src/pipeline/ci-poller.ts` (new), `src/integrations/github/client.ts` (add `getCheckRuns`, `getCheckRunLog` methods), `src/pipeline/stages/5-git.ts` (call `waitForCI` after PR creation), `src/config/schema.ts` (add `waitForCI`, `ciTimeoutMs`, `ciPollBackoff`, `requiredChecks` fields), `src/pipeline/state.ts` (add `CI_POLLING_STARTED`, `CI_COMPLETED`, `CI_TIMEOUT` event types), `src/memory/context-builder.ts` (add `writeCIStatus` export)
- Scope:
  - Add CI event types to the `PipelineEvent` union in `src/pipeline/state.ts`:
    ```typescript
    | { type: 'CI_POLLING_STARTED'; sha: string; requiredChecks: string[]; timeoutMs: number; timestamp: string }
    | { type: 'CI_COMPLETED'; status: 'success' | 'failure'; passedCount: number; failedCount: number; durationMs: number; timestamp: string }
    | { type: 'CI_TIMEOUT'; elapsedMs: number; pendingChecks: string[]; timestamp: string }
    ```
  - Add CI config fields to `github` section in `src/config/schema.ts`:
    ```typescript
    waitForCI: z.boolean().default(true),
    ciTimeoutMs: z.number().default(1_800_000),  // 30min
    ciPollBackoff: z.object({
      initialMs: z.number().default(5_000),
      multiplier: z.number().default(2),
      maxMs: z.number().default(60_000),
    }).default({}),
    requiredChecks: z.array(z.string()).default([]),
    ```
  - Add methods to `GitHubClient` interface and implementation in `src/integrations/github/client.ts`:
    ```typescript
    // Interface additions:
    getCheckRuns(sha: string): Promise<CheckRun[]>
    getCheckRunLog(checkRunId: number): Promise<string>

    // Types:
    export interface CheckRun {
      id: number
      name: string
      status: 'completed' | 'in_progress' | 'queued'
      conclusion: 'success' | 'failure' | 'neutral' | 'skipped' | null
      startedAt: string | null
      completedAt: string | null
    }
    ```
    - `getCheckRuns`: uses `octokit.checks.listForRef({ owner, repo, ref: sha })`
    - `getCheckRunLog`: uses `octokit.checks.get({ owner, repo, check_run_id })` and returns
      `data.output?.text ?? data.output?.summary ?? ''` truncated to 2000 chars
  - Create `src/pipeline/ci-poller.ts`:
    ```typescript
    import type { GitHubClient, CheckRun } from '../integrations/github/client.js'
    import type { Logger } from 'pino'

    export interface CIResult {
      status: 'success' | 'failure' | 'timeout'
      checks: Array<{
        name: string
        status: 'completed' | 'in_progress' | 'queued'
        conclusion: 'success' | 'failure' | 'neutral' | 'skipped' | null
        durationMs: number
      }>
      failedLogs: string[]
      totalDurationMs: number
    }

    export interface CIPollConfig {
      timeoutMs: number
      backoff: { initialMs: number; multiplier: number; maxMs: number }
      requiredChecks: string[]
    }

    export async function waitForCI(
      github: GitHubClient,
      sha: string,
      config: CIPollConfig,
      logger: Logger,
    ): Promise<CIResult>
    ```
    - Polling loop with exponential backoff:
      ```typescript
      let delay = config.backoff.initialMs   // 5000
      let elapsed = 0
      const start = Date.now()

      while (elapsed < config.timeoutMs) {
        const allChecks = await github.getCheckRuns(sha)
        let checks = allChecks
        if (config.requiredChecks.length > 0) {
          checks = allChecks.filter(c => config.requiredChecks.includes(c.name))
          // Warn about missing required checks
          const found = new Set(checks.map(c => c.name))
          for (const req of config.requiredChecks) {
            if (!found.has(req)) logger.warn({ check: req }, 'Required CI check not found')
          }
        }

        if (checks.length === 0) {
          // No checks configured on repo → treat as success
          return { status: 'success', checks: [], failedLogs: [], totalDurationMs: Date.now() - start }
        }

        const allCompleted = checks.every(c => c.status === 'completed')
        if (allCompleted) {
          const failed = checks.filter(c => c.conclusion === 'failure')
          const failedLogs: string[] = []
          for (const f of failed.slice(0, 3)) {
            const log = await github.getCheckRunLog(f.id).catch(() => '')
            if (log) failedLogs.push(`${f.name}:\n${log.slice(0, 2000)}`)
          }
          return {
            status: failed.length > 0 ? 'failure' : 'success',
            checks: checks.map(c => ({ ... })),
            failedLogs,
            totalDurationMs: Date.now() - start,
          }
        }

        await sleep(delay)
        elapsed = Date.now() - start
        delay = Math.min(delay * config.backoff.multiplier, config.backoff.maxMs)
        logger.debug({ elapsed, nextDelay: delay, pending: checks.filter(c => c.status !== 'completed').length }, 'CI polling')
      }

      // Timeout
      const pending = checks.filter(c => c.status !== 'completed').map(c => c.name)
      return { status: 'timeout', checks: [...], failedLogs: [], totalDurationMs: Date.now() - start }
      ```
  - Add `writeCIStatus` to `src/memory/context-builder.ts`:
    ```typescript
    export function writeCIStatus(memoryDir: string, result: CIResult): void
    ```
    - Writes `memory/ci-status.md` with CI status summary and failed check logs
    - This file is included in `getContextFilesForStage()` for `review` stage
  - Update `getContextFilesForStage()` in `src/memory/context-builder.ts`:
    - For `stage === 'review'`: also include `ci-status.md` if it exists
  - Modify `src/pipeline/stages/5-git.ts`:
    - After PR creation (after `return { branchName, prNumber }` in the non-dry-run path), insert CI polling:
      ```typescript
      // After PR created and reviewers added:
      if (config.github.waitForCI !== false) {
        const headSha = await getHeadSha(workdir)  // git rev-parse HEAD
        ctx.state.emit({
          type: 'CI_POLLING_STARTED',
          sha: headSha,
          requiredChecks: config.github.requiredChecks ?? [],
          timeoutMs: config.github.ciTimeoutMs ?? 1_800_000,
        })
        await ctx.telegram.updateDetail('Waiting for CI checks…').catch(() => undefined)

        const ciResult = await waitForCI(ctx.github, headSha, {
          timeoutMs: config.github.ciTimeoutMs ?? 1_800_000,
          backoff: config.github.ciPollBackoff ?? { initialMs: 5000, multiplier: 2, maxMs: 60000 },
          requiredChecks: config.github.requiredChecks ?? [],
        }, ctx.logger)

        if (ciResult.status === 'timeout') {
          ctx.state.emit({
            type: 'CI_TIMEOUT',
            elapsedMs: ciResult.totalDurationMs,
            pendingChecks: ciResult.checks.filter(c => c.status !== 'completed').map(c => c.name),
          })
          ctx.logger.warn({ ticketKey }, 'CI timed out — proceeding to review')
        } else {
          ctx.state.emit({
            type: 'CI_COMPLETED',
            status: ciResult.status,
            passedCount: ciResult.checks.filter(c => c.conclusion === 'success').length,
            failedCount: ciResult.checks.filter(c => c.conclusion === 'failure').length,
            durationMs: ciResult.totalDurationMs,
          })
        }

        writeCIStatus(ctx.memoryDir, ciResult)
        await ctx.telegram.updateDetail(`CI: ${ciResult.status}`).catch(() => undefined)
      }

      return { branchName, prNumber }
      ```
    - Add unexported helper:
      ```typescript
      async function getHeadSha(workdir: string): Promise<string> {
        const result = await spawnSafe('git', ['rev-parse', 'HEAD'], { cwd: workdir })
        return result.stdout.trim()
      }
      ```
    - In dry-run mode: log `"Would wait for CI"` but skip polling
  - CI timeout does NOT abort the pipeline — it proceeds to review with "CI timed out" in context
  - CI failure does NOT abort — review agents receive failure logs to focus their review
- Deps: none (builds on existing `GitHubClient`, `spawnSafe`, `StateManager`)
- Acceptance:
  ```json
  {
    "github": {
      "waitForCI": true,
      "ciTimeoutMs": 1800000,
      "ciPollBackoff": { "initialMs": 5000, "multiplier": 2, "maxMs": 60000 },
      "requiredChecks": ["lint", "test", "build"]
    }
  }
  ```
  ```
  jiraACP run PROJ-123 --project my-saas
  # After PR creation: polls CI with backoff 5s → 10s → 20s → 40s → 60s → 60s (capped)
  # state.json: CI_POLLING_STARTED { sha, requiredChecks: ["lint","test","build"] }
  # All checks pass → CI_COMPLETED { status: "success", passedCount: 3, failedCount: 0 }
  # memory/ci-status.md written for review context

  # CI failure:
  # CI_COMPLETED { status: "failure", failedCount: 1 }
  # ci-status.md includes failure logs (max 2000 chars per check)
  # Review stage receives CI failure context → agents focus on broken area

  # CI timeout (30min):
  # CI_TIMEOUT { elapsedMs: 1800000, pendingChecks: ["test"] }
  # ci-status.md includes "CI timed out" note
  # Pipeline proceeds to review anyway

  # waitForCI: false → no polling, skips entirely
  # No CI checks on repo → immediate success, no polling
  # requiredChecks has non-existent check → warning logged, waits for existing checks only

  # Dry-run:
  jiraACP run PROJ-123 --project my-saas --dry-run
  # Logs "Would wait for CI" — does NOT poll
  ```

---

## Definition of Done (Sprint 4)

- `npm run build` exits 0 with zero TypeScript errors
- No `any` — use `unknown` + type guard where dynamic types are needed
- All new exports have explicit return types
- All imports use `.js` extension (ESM)
- No `console.log` in production paths — pino logger only
- All subprocess calls use `spawnSafe` (never `exec`)
- New config fields use `.default()` or `.optional()` — backward compatible with existing configs
- New event types added to `PipelineEvent` union without breaking `applyEvent()` default case
