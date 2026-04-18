# Feature 07 — Learning Loop: Auto-Retry with Feedback

> Priority: Tier 2 (high value) · Size: M · Sprint 5

## Problem

When stage 6 (Review) finds major issues or stage 8 (Test) fails, the pipeline aborts. The developer must:
1. Read the review feedback or test output
2. Manually re-run the pipeline from stage 4
3. Hope the agent learns from the feedback

This breaks the "set it and forget it" promise. The feedback context exists but isn't fed back to the coding agent automatically.

## Solution

Add an automatic retry mechanism: when review or test fails, feed the failure context back into stage 4 (Code) and re-run stages 4→8. Configurable max retries to prevent infinite loops.

## CLI / Config

```bash
# Existing command, behavior changes with config
jiraACP run PROJ-123          # now retries automatically if enabled
jiraACP run PROJ-123 --no-retry   # disable retry for this run
```

```jsonc
{
  "pipeline": {
    "autoRetry": {
      "enabled": true,                   // NEW — default false (opt-in)
      "maxRetries": 2,                   // NEW — max retry cycles (default 2)
      "retryFromStage": "code",          // NEW — which stage to restart from (default "code")
      "retryOnReviewReject": true,       // NEW — retry when review has major issues
      "retryOnTestFailure": true         // NEW — retry when tests fail
    }
  }
}
```

## Architecture

### New files

| File | Purpose |
|------|---------|
| `src/pipeline/retry.ts` | `RetryController` — manages retry state, feedback collection, and re-execution |

### Modified files

| File | Change |
|------|--------|
| `src/pipeline/orchestrator.ts` | After stage 6 or 8 failure, check retry config → invoke RetryController |
| `src/pipeline/stages/4-code.ts` | Accept optional `retryContext` parameter with prior feedback |
| `src/pipeline/stages/6-review.ts` | Return structured `ReviewResult` with issues list |
| `src/memory/context-builder.ts` | Add `buildRetryContext()` to merge feedback into coding prompt |
| `src/pipeline/state.ts` | Add `RETRY_STARTED`, `RETRY_SUCCEEDED`, `RETRY_EXHAUSTED` events |
| `src/integrations/telegram/notifier.ts` | Add retry notification messages |

### RetryController

```typescript
interface RetryContext {
  attempt: number;              // 1-based (1 = first retry)
  maxAttempts: number;
  trigger: "review" | "test";
  feedback: string;             // review issues or test failure output
  priorDiff: string;            // git diff of what was attempted
  priorPR: string;              // PR URL for reference
}

class RetryController {
  async shouldRetry(
    failure: StageFailure,
    config: AutoRetryConfig,
    state: RunState,
  ): Promise<boolean>;

  buildRetryContext(failure: StageFailure, state: RunState): RetryContext;

  async executeRetry(
    context: RetryContext,
    pipeline: PipelineExecutor,
  ): Promise<RetryResult>;
}
```

### Flow

```
Normal pipeline: 1→2→3→4→5→6→7→8→9

With retry on review reject (attempt 1):
  1→2→3→4→5→6(REJECT)
    → build retry context (review issues + prior diff)
    → Telegram: "Review rejected (3 major issues). Retrying (1/2)..."
    → 4(with feedback)→5→6(PASS)→7→8→9 ✓

With retry on test failure (attempt 2 — final):
  1→2→3→4→5→6→7→8(FAIL)
    → build retry context (test output + prior diff)
    → Telegram: "Tests failed. Final retry (2/2)..."
    → 4(with feedback)→5→6→7→8(FAIL again)
    → RETRY_EXHAUSTED → abort
    → Telegram: "Pipeline failed after 2 retries. Manual intervention needed."
```

### Retry context memory file

```markdown
# Retry Context (Attempt 1/2)

## Trigger: Review Rejection

## Issues Found
1. [MAJOR] Missing input validation in createUser() — no email format check
2. [MAJOR] SQL query uses string concatenation — potential injection
3. [MINOR] Missing JSDoc on exported function

## Prior Implementation (diff summary)
- Modified: src/controllers/user.ts (+45 lines)
- Modified: src/services/user.ts (+30 lines)
- New: src/__tests__/user.test.ts (+80 lines)

## Instructions
Fix the major issues listed above. Keep changes that were not flagged.
Do NOT rewrite from scratch — apply targeted fixes.
```

## Events

| Event | Data |
|-------|------|
| `RETRY_STARTED` | `{ attempt, maxAttempts, trigger, issueCount }` |
| `RETRY_SUCCEEDED` | `{ attempt, trigger }` |
| `RETRY_EXHAUSTED` | `{ attempts, trigger, lastFailureReason }` |

## Edge Cases

1. **`autoRetry.enabled: false`** → current behavior (abort on failure). Default.
2. **Review approved but test fails** → retry from code with test output as context.
3. **Both review reject and test fail** → retry handles whichever triggers first (review before test).
4. **Retry succeeds on review but fails on test** → counts as separate retry triggers (each has its own counter? or shared?). Use **shared counter** — total retries across all triggers.
5. **`--no-retry` flag** → disable for this run only, regardless of config.
6. **Agent produces identical code on retry** → diff comparison detects no change → abort early instead of retrying forever.
7. **PR already exists from attempt 1** → force-push to same branch, update PR description with retry attempt number.
8. **Cost guard hit during retry** → abort. Retry does not bypass cost limits.
9. **Dry-run** → simulate retry flow but don't execute agents.

## Test Plan

- [ ] Unit: `shouldRetry()` returns true when within max attempts
- [ ] Unit: `shouldRetry()` returns false when max attempts exceeded
- [ ] Unit: `buildRetryContext()` includes review issues
- [ ] Unit: `buildRetryContext()` includes test failure output
- [ ] Unit: stage 4 receives retry context in prompt
- [ ] Unit: shared retry counter across review + test triggers
- [ ] Unit: identical code detection → early abort
- [ ] Unit: `--no-retry` disables retry
- [ ] Unit: `RETRY_STARTED/SUCCEEDED/EXHAUSTED` events emitted correctly
- [ ] Unit: cost guard respected during retry
- [ ] Integration: Telegram notifications for retry start/success/exhausted
