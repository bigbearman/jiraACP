# Feature 03 — Memory File Mutex for Concurrent Agents

> Priority: Tier 1 (gap fill) · Size: XS · Sprint 4

## Problem

Stage 6 (Review) runs 2 parallel agents via `runAgentsParallel()`. Both agents read and potentially write to the same context files (`ticket-context.md`, `coding-plan.md`, `review-feedback.md`). No file-level locking exists — concurrent writes can corrupt or overwrite content.

## Solution

Add a simple file mutex using the existing `O_EXCL` lock pattern (from `src/utils/lock.ts`) scoped to individual memory files. Each agent acquires a per-file lock before writing, releases after write completes.

## Architecture

### Affected files

| File | Change |
|------|--------|
| `src/utils/lock.ts` | Add `acquireFileLock(path)` / `releaseFileLock(path)` — reuse existing `O_EXCL` pattern |
| `src/memory/context-builder.ts` | Wrap all `writeFileSync` calls with lock acquire/release |
| `src/pipeline/stages/6-review.ts` | Ensure parallel agents get isolated write contexts |

### Approach: Isolated output files (preferred over locking)

Instead of both agents writing to the same file with locks, give each agent its own output:

```
~/.jira-acp/runs/<project>/<ticket>/memory/
  ticket-context.md          # shared, read-only during review
  coding-plan.md             # shared, read-only during review
  review-logic.md            # agent 1 writes here (NEW)
  review-quality.md          # agent 2 writes here (NEW)
  review-feedback.md         # merged output (stage 6 post-processing)
```

This eliminates the race condition entirely — no mutex needed for the common case. The merge step runs sequentially after both agents complete.

### Fallback: File lock for other stages

For any future parallel writes outside review, add generic lock:

```typescript
async function withFileLock<T>(
  filePath: string,
  fn: () => Promise<T>,
  timeout?: number,
): Promise<T>;
```

- Lock file: `${filePath}.lock` (O_EXCL create)
- Default timeout: 10s
- On timeout: throw `FileLockTimeout` error
- Always release in `finally` block

## Edge Cases

1. **Agent crashes mid-write** → stale `.lock` file → `withFileLock` checks lock age, removes if > 60s.
2. **Single agent mode** (no parallel) → no lock needed, works unchanged.
3. **Read-only access** → no lock required, only write operations lock.

## Test Plan

- [ ] Unit: two parallel writes to same file — both complete without corruption
- [ ] Unit: lock timeout throws `FileLockTimeout`
- [ ] Unit: stale lock (> 60s) is auto-removed
- [ ] Unit: review stage produces separate `review-logic.md` and `review-quality.md`
- [ ] Unit: `review-feedback.md` is merged correctly from both agent outputs
