# Feature 01 — Auto-Rollback on Deploy/Test Failure

> Priority: Tier 1 (gap fill) · Size: S · Sprint 4

## Problem

`rollbackCommand` is already in config schema but **never invoked**. When stage 7 (Deploy) health-check fails or stage 8 (Test) Playwright fails, the pipeline aborts — leaving a broken deploy in place. The operator must manually SSH in and rollback.

## Solution

Wire `rollbackCommand` into the failure path of stages 7 and 8. On failure:
1. Execute `rollbackCommand` via `spawnSafe()` (same environment as `deployCommand`)
2. Emit `DEPLOY_ROLLED_BACK` event to state log
3. Send Telegram alert with failure reason + rollback status
4. Mark stage as `FAILED_AND_ROLLED_BACK` (new status)

If `rollbackCommand` is not configured, current behavior (abort without rollback) is preserved.

## CLI / Config

No new CLI commands. Config change:

```jsonc
// ~/.jira-acp/projects/<name>.json (already exists, currently unused)
{
  "deploy": {
    "command": "deploy.sh",
    "rollbackCommand": "rollback.sh",     // ← now actually invoked
    "healthCheckUrl": "https://...",
    "healthCheckTimeout": 30000,
    "rollbackTimeout": 60000              // NEW — default 60s
  }
}
```

## Architecture

### Affected files

| File | Change |
|------|--------|
| `src/pipeline/stages/7-deploy.ts` | On health-check fail → call `executeRollback()` before throwing |
| `src/pipeline/stages/8-test.ts` | On test fail → call `executeRollback()` before throwing |
| `src/pipeline/rollback.ts` | **NEW** — `executeRollback(config, context): Promise<RollbackResult>` |
| `src/pipeline/state.ts` | Add `DEPLOY_ROLLED_BACK` event type |
| `src/config/schema.ts` | Add `rollbackTimeout` field (default 60000) |
| `src/integrations/telegram/notifier.ts` | Add `notifyRollback()` message template |

### Flow

```
Stage 7 Deploy
  ├─ healthCheck() → OK → continue to stage 8
  └─ healthCheck() → FAIL
       ├─ rollbackCommand configured?
       │   ├─ YES → executeRollback() → emit DEPLOY_ROLLED_BACK
       │   │   ├─ rollback OK → Telegram: "Deploy failed, rolled back ✓"
       │   │   └─ rollback FAIL → Telegram: "Deploy failed, rollback ALSO failed ⚠️"
       │   └─ NO → current behavior (abort)
       └─ throw StageError (pipeline stops)

Stage 8 Test
  └─ playwright fails after retries
       └─ same rollback flow as above
```

### `executeRollback()` contract

```typescript
interface RollbackResult {
  success: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
}

async function executeRollback(
  config: DeployConfig,
  context: RunContext,
): Promise<RollbackResult>;
```

- Uses `spawnSafe()` (existing util from `src/utils/process.ts`) — never raw shell execution
- Timeout: `rollbackTimeout` (default 60s)
- Env vars: same as `deployCommand` (TICKET_KEY, BRANCH, PR_URL, etc.)
- Logs stdout/stderr to run log file

## Events

| Event | Data |
|-------|------|
| `DEPLOY_ROLLED_BACK` | `{ trigger: "deploy" \| "test", success: boolean, durationMs: number }` |

## Edge Cases

1. **rollbackCommand not configured** → skip rollback, abort as before. No error.
2. **Rollback itself fails** → log error, Telegram alert with both deploy + rollback errors, abort pipeline. Do NOT retry rollback.
3. **rollbackCommand hangs** → kill after `rollbackTimeout`, treat as rollback failure.
4. **Dry-run mode** → log "would rollback" but don't execute.
5. **Stage 8 skipped** (test disabled) → no rollback path needed for test stage.

## Test Plan

- [ ] Unit: `executeRollback()` calls `spawnSafe()` with correct args/env
- [ ] Unit: rollback timeout kills process and returns `success: false`
- [ ] Unit: stage 7 calls rollback on health-check failure
- [ ] Unit: stage 8 calls rollback on test failure
- [ ] Unit: no rollback if `rollbackCommand` not configured
- [ ] Unit: `DEPLOY_ROLLED_BACK` event emitted with correct data
- [ ] Unit: dry-run does not execute rollback
- [ ] Integration: Telegram receives rollback notification
