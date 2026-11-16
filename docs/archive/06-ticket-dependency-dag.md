> **Archived idea, not a roadmap.** The current direction is in [docs/PRODUCT.md](../PRODUCT.md). **Status: out of scope.** The experimental `sprint` command contains a partial dependency-ordered runner; it is not maintained.

# Feature 06 — Multi-Ticket Dependency DAG

> Priority: Tier 2 (high value) · Size: M · Sprint 5

## Problem

`jiraACP sprint` runs all tickets in parallel without considering dependencies. In practice, tickets often have `blockedBy` / `blocks` relationships in Jira (e.g., API feature must land before frontend uses it). Running them in parallel causes:
- PR merge conflicts when dependent tickets touch same files
- Build failures when child ticket references code not yet merged
- Wasted compute when blocker ticket fails but children proceed anyway

## Solution

Build a DAG from Jira issue links, topologically sort it, and execute tickets in waves:
1. Fetch all sprint tickets + their issue links from Jira
2. Build dependency graph (DAG)
3. Validate: detect cycles, warn if dependency is outside sprint
4. Execute in topological waves: independent tickets run parallel within a wave, next wave starts only after current wave completes

## CLI

```bash
# Existing command, new flag
jiraACP sprint --respect-deps [--parallel <n>]

# New command: visualize dependency graph
jiraACP deps <ticketKey>              # show deps tree for one ticket
jiraACP deps --sprint <name>          # show full sprint DAG
```

## Config

```jsonc
{
  "pipeline": {
    "respectDependencies": false,         // NEW — default false (opt-in)
    "dependencyLinkTypes": [              // NEW — which Jira link types to follow
      "Blocks",
      "is blocked by"
    ],
    "failFastOnBlockerFailure": true      // NEW — abort dependents if blocker fails
  }
}
```

## Architecture

### New files

| File | Purpose |
|------|---------|
| `src/pipeline/dag.ts` | `buildDAG()`, `topoSort()`, `detectCycles()`, `getWaves()` |
| `src/commands/deps.ts` | CLI handler for `jiraACP deps` command |

### Modified files

| File | Change |
|------|--------|
| `src/cli.ts` | Register `deps` command |
| `src/commands/sprint.ts` | If `--respect-deps`, use DAG execution instead of flat parallel |
| `src/integrations/jira/client.ts` | Add `getIssueLinks(ticketKey)` method |
| `src/integrations/jira/tools.ts` | Add `jira_get_dependencies` MCP tool |
| `src/pipeline/state.ts` | Add `DAG_WAVE_STARTED`, `DAG_BLOCKER_FAILED` events |

### DAG module

```typescript
interface TicketNode {
  key: string;
  blockedBy: string[];     // tickets that must complete first
  blocks: string[];        // tickets waiting on this one
}

interface DAGResult {
  waves: string[][];                // [ ["PROJ-1", "PROJ-2"], ["PROJ-3"], ["PROJ-4"] ]
  cycles: string[][] | null;       // null if no cycles
  externalDeps: string[];          // deps outside current sprint
}

function buildDAG(tickets: TicketNode[]): DAGResult;
function topoSort(nodes: Map<string, TicketNode>): string[][];
function detectCycles(nodes: Map<string, TicketNode>): string[][] | null;
```

### Execution flow

```
sprint --respect-deps:

  1. Fetch all sprint tickets
  2. For each ticket → getIssueLinks() → extract blockedBy/blocks
  3. buildDAG() → detect cycles, compute waves

  4. If cycles detected:
     → Telegram: "⚠️ Circular dependency: PROJ-1 → PROJ-2 → PROJ-1"
     → Abort sprint (or remove cycle edges if --force)

  5. If external deps:
     → Telegram: "ℹ️ PROJ-5 depends on PROJ-99 (not in sprint)"

  6. Execute waves sequentially:
     Wave 1: [PROJ-1, PROJ-2] → run parallel (max --parallel)
     Wave 2: [PROJ-3]         → starts after wave 1 completes
     Wave 3: [PROJ-4, PROJ-5] → starts after wave 2 completes

  7. If blocker fails AND failFastOnBlockerFailure:
     → Skip all dependents
     → Telegram: "PROJ-3 skipped — blocker PROJ-1 failed"
```

### `deps` command output

```
$ jiraACP deps --sprint "Sprint 42"

Sprint 42 — Dependency Graph

Wave 1 (parallel):
  ✅ PROJ-1  Add user auth API
  ✅ PROJ-2  Setup Redis cache

Wave 2 (after wave 1):
  ⏳ PROJ-3  Auth middleware (blocked by: PROJ-1)

Wave 3 (after wave 2):
  ⏳ PROJ-4  User dashboard (blocked by: PROJ-1, PROJ-3)
  ⏳ PROJ-5  Cache invalidation (blocked by: PROJ-2)

External deps (not in sprint):
  ⚠️ PROJ-99  Database migration (PROJ-3 depends on this)
```

## Edge Cases

1. **No dependencies** → single wave with all tickets parallel (same as current behavior).
2. **Cycle detected** → abort with clear error message listing the cycle path.
3. **`--respect-deps` not set** → current parallel behavior, DAG not computed.
4. **Dependency on ticket outside sprint** → warning, proceed anyway (external dep assumed complete).
5. **Blocker ticket paused/aborted** → dependents wait or skip based on `failFastOnBlockerFailure`.
6. **Blocker ticket succeeds but dependent ticket fails** → no impact on other dependents.
7. **Diamond dependency** (A → B, A → C, B → D, C → D) → D runs in correct wave after both B and C.
8. **Self-referencing ticket** → treated as cycle, error.

## Test Plan

- [ ] Unit: `buildDAG()` with 0 deps → single wave
- [ ] Unit: `buildDAG()` with linear chain → N waves of 1
- [ ] Unit: `buildDAG()` with diamond → correct 3 waves
- [ ] Unit: `detectCycles()` finds circular dependencies
- [ ] Unit: external deps detected and reported
- [ ] Unit: `failFastOnBlockerFailure` skips dependents
- [ ] Unit: `deps` command renders correct tree output
- [ ] Integration: sprint with `--respect-deps` executes waves in order
- [ ] Integration: Telegram notifications for cycles, external deps, skipped tickets
