> **Archived idea, not a roadmap.** The current direction is in [docs/PRODUCT.md](../PRODUCT.md). **Status: implemented** in `src/pipeline/ci-poller.ts`, called from the git stage.

# Feature 02 — CI Status Polling with Exponential Backoff

> Priority: Tier 1 (gap fill) · Size: S · Sprint 4

## Problem

Stage 5 (Git) creates a PR, then the pipeline proceeds to stage 6 (Review). However, there's no mechanism to wait for CI checks to complete. Long-running CI workflows (20+ minutes) are ignored or hit a hardcoded 10-minute timeout. Review agents lack CI context — they review code without knowing if CI passed or failed.

## Solution

Add a configurable CI polling step between stage 5 and stage 6. After PR creation:
1. Poll GitHub CI status with exponential backoff (5s → 10s → 30s → 60s)
2. Wait until all checks complete or timeout
3. Pass CI result to stage 6 as review context
4. On CI failure: include failure logs in review context so agents focus on the broken area

## CLI / Config

No new CLI commands. Config additions:

```jsonc
{
  "github": {
    "waitForCI": true,                    // NEW — default true
    "ciTimeout": 1800000,                 // NEW — 30min default (ms)
    "ciPollBackoff": {                    // NEW — optional, has defaults
      "initial": 5000,
      "multiplier": 2,
      "max": 60000
    },
    "requiredChecks": []                  // NEW — optional, wait for specific check names only
  }
}
```

## Architecture

### Affected files

| File | Change |
|------|--------|
| `src/pipeline/stages/5-git.ts` | After PR creation, call `waitForCI()` if enabled |
| `src/pipeline/ci-poller.ts` | **NEW** — `waitForCI(owner, repo, sha, config): Promise<CIResult>` |
| `src/integrations/github/client.ts` | Add `getCheckRuns(owner, repo, sha)` and `getCheckRunLog(id)` |
| `src/config/schema.ts` | Add `waitForCI`, `ciTimeout`, `ciPollBackoff`, `requiredChecks` fields |
| `src/pipeline/state.ts` | Add `CI_POLLING_STARTED`, `CI_COMPLETED`, `CI_TIMEOUT` events |
| `src/integrations/telegram/notifier.ts` | Add CI status update in progress message |

### Polling algorithm

```
waitForCI(sha, config):
  delay = config.ciPollBackoff.initial   // 5s
  elapsed = 0

  while elapsed < config.ciTimeout:
    checks = await getCheckRuns(sha)

    if requiredChecks.length > 0:
      checks = checks.filter(c => requiredChecks.includes(c.name))

    if all checks completed:
      return { status: allPassed ? "success" : "failure", checks, failedLogs }

    await sleep(delay)
    elapsed += delay
    delay = min(delay * config.ciPollBackoff.multiplier, config.ciPollBackoff.max)

  return { status: "timeout", checks }
```

### CIResult interface

```typescript
interface CIResult {
  status: "success" | "failure" | "timeout";
  checks: Array<{
    name: string;
    status: "completed" | "in_progress" | "queued";
    conclusion: "success" | "failure" | "neutral" | "skipped" | null;
    durationMs: number;
  }>;
  failedLogs: string[];     // truncated logs of failed checks (max 2000 chars each)
  totalDurationMs: number;
}
```

### Integration with stage 6

```typescript
// In stage 6 review context (memory/ci-status.md):
// ## CI Status: FAILED
// ### Failed checks:
// - `lint` (exit 1): ESLint found 3 errors in src/foo.ts
// - `test` (exit 1): 2 tests failed in bar.test.ts
//
// Review agents receive this context → focus review on failing areas
```

## Events

| Event | Data |
|-------|------|
| `CI_POLLING_STARTED` | `{ sha, requiredChecks, timeout }` |
| `CI_COMPLETED` | `{ status, passedCount, failedCount, durationMs }` |
| `CI_TIMEOUT` | `{ elapsed, pendingChecks }` |

## Edge Cases

1. **No CI checks configured on repo** → `getCheckRuns()` returns empty → treat as "success", skip polling.
2. **CI timeout** → proceed to review anyway, but include "CI timed out" in context. Do not abort.
3. **`waitForCI: false`** → skip entirely, current behavior preserved.
4. **PR already has completed checks** (re-run scenario) → first poll returns immediately.
5. **`requiredChecks` contains non-existent check** → warn in log, wait for the rest only.
6. **Dry-run** → log "would wait for CI" but skip polling.
7. **Rate limiting** → GitHub API rate limit → increase backoff delay, continue polling.

## Test Plan

- [ ] Unit: backoff sequence 5s → 10s → 20s → 40s → 60s → 60s (capped)
- [ ] Unit: returns "success" when all checks pass
- [ ] Unit: returns "failure" with logs when checks fail
- [ ] Unit: returns "timeout" after `ciTimeout` exceeded
- [ ] Unit: filters by `requiredChecks` when configured
- [ ] Unit: empty check list → immediate success
- [ ] Unit: `waitForCI: false` → skips polling
- [ ] Unit: CI result written to memory/ci-status.md for review context
- [ ] Unit: dry-run does not poll
