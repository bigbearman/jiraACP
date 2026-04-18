# Feature 10 — Web Dashboard (Read-Only)

> Priority: Tier 2 (visibility) · Size: M-L · Sprint 6

## Problem

The terminal `dashboard` command works for single operators but doesn't scale. Team leads and stakeholders need visibility into pipeline runs, cost tracking, and ticket status without terminal access. No web UI exists.

## Solution

Add a lightweight web dashboard served from the existing `serve` HTTP server (port 3110). Read-only — no mutation actions. Renders pipeline state from existing `~/.jira-acp/runs/` data.

## Design Principles

- **Zero external dependencies** for frontend — vanilla HTML + CSS + JS, server-rendered
- **Read-only** — no API mutations, no auth needed (local network only)
- **Real-time** via SSE (Server-Sent Events) — no WebSocket complexity
- **Data from existing files** — reads state.json, event logs, cost data

## Routes

| Route | Description |
|-------|-------------|
| `GET /` | Dashboard home — active runs + recent completed |
| `GET /runs` | All runs list with filters (project, status, date) |
| `GET /runs/:project/:ticket` | Single run detail — timeline, logs, cost |
| `GET /costs` | Cost overview — per project/month/model chart |
| `GET /api/runs` | JSON API — active + recent runs |
| `GET /api/runs/:project/:ticket` | JSON API — single run detail |
| `GET /api/costs` | JSON API — cost aggregation |
| `GET /api/events` | SSE stream — real-time pipeline events |

## Architecture

### New files

| File | Purpose |
|------|---------|
| `src/dashboard/router.ts` | Express/Hono router for dashboard routes |
| `src/dashboard/views/layout.ts` | HTML layout template (header, nav, footer) |
| `src/dashboard/views/home.ts` | Active runs + recent completed |
| `src/dashboard/views/run-detail.ts` | Single run timeline + logs |
| `src/dashboard/views/costs.ts` | Cost charts (inline SVG, no chart library) |
| `src/dashboard/api.ts` | JSON API endpoints |
| `src/dashboard/sse.ts` | SSE event stream from state file watchers |
| `src/dashboard/styles.ts` | Inline CSS (dark/light theme) |
| `src/dashboard/data.ts` | Read state.json files, aggregate, transform |

### Modified files

| File | Change |
|------|--------|
| `src/commands/serve.ts` | Mount dashboard router at `/` |
| `src/config/schema.ts` | Add `dashboard.enabled` (default true) |

### Data flow

```
~/.jira-acp/runs/<project>/<ticket>/state.json
  → data.ts reads + parses all state files
  → transforms to DashboardRun[]
  → views render server-side HTML
  → SSE pushes updates via fs.watch on state files
```

### DashboardRun interface

```typescript
interface DashboardRun {
  project: string;
  ticket: string;
  status: "running" | "completed" | "failed" | "paused" | "aborted";
  currentStage: number;
  stages: Array<{
    name: string;
    status: "pending" | "running" | "completed" | "skipped" | "failed";
    startedAt?: string;
    completedAt?: string;
    durationMs?: number;
    agentModel?: string;
  }>;
  cost: {
    totalUsd: number;
    byModel: Record<string, number>;
    tokenCount: number;
  };
  startedAt: string;
  completedAt?: string;
  retryCount: number;
  events: StateEvent[];
}
```

### Home page layout

```
┌─────────────────────────────────────────────────────┐
│  jiraACP Dashboard                    myproject  ▼  │
├─────────────────────────────────────────────────────┤
│                                                     │
│  Active Runs (2)                                    │
│  ┌─────────────────────────────────────────────┐   │
│  │ PROJ-42  Add auth API     ████████░░  6/9   │   │
│  │          Review · $0.12 · 4m elapsed        │   │
│  ├─────────────────────────────────────────────┤   │
│  │ PROJ-45  Fix login bug    ██░░░░░░░░  2/9   │   │
│  │          Analyze · $0.02 · 1m elapsed       │   │
│  └─────────────────────────────────────────────┘   │
│                                                     │
│  Recent (last 24h)                                  │
│  ┌──────────┬──────────┬──────┬───────┬─────────┐  │
│  │ Ticket   │ Status   │ Cost │ Time  │ Retries │  │
│  ├──────────┼──────────┼──────┼───────┼─────────┤  │
│  │ PROJ-40  │ ✅ Done  │ $0.45│ 12m   │ 0       │  │
│  │ PROJ-39  │ ❌ Failed│ $0.30│ 8m    │ 2       │  │
│  │ PROJ-38  │ ✅ Done  │ $0.22│ 6m    │ 0       │  │
│  └──────────┴──────────┴──────┴───────┴─────────┘  │
│                                                     │
│  Today: 5 runs · $1.20 total · 82% success rate    │
└─────────────────────────────────────────────────────┘
```

### Run detail page

```
PROJ-42: Add user authentication API
Started: 2026-04-18 09:15 · Elapsed: 4m 22s · Cost: $0.12

Timeline:
  ✅ 1. Fetch        0.3s   haiku    $0.001
  ✅ 2. Analyze      4.2s   sonnet   $0.015
  ⏭️ 3. Clarify     skipped (score: 0.85)
  ✅ 4. Code        2m 10s  opus     $0.080
  ✅ 5. Git          1.8s   haiku    $0.001
  🔄 6. Review      running...
  ⏳ 7. Deploy      pending
  ⏳ 8. Test        pending
  ⏳ 9. Notify      pending

Event Log:
  09:15:00  STAGE_STARTED   fetch
  09:15:01  STAGE_COMPLETED fetch         0.3s
  09:15:01  STAGE_STARTED   analyze
  ...
```

### SSE stream

```typescript
// Client connects:
// GET /api/events?project=myproject
// → Server sends events as they happen:

// data: {"type":"stage_completed","ticket":"PROJ-42","stage":"review","durationMs":15000}
// data: {"type":"run_completed","ticket":"PROJ-42","status":"success","cost":0.45}
// data: {"type":"run_started","ticket":"PROJ-45","stage":"fetch"}
```

## Edge Cases

1. **No runs exist** → empty state, show "No pipeline runs yet" message.
2. **Large number of runs** (1000+) → paginate `/runs` list, lazy-load older runs.
3. **State file corrupted** → skip that run, show "Error loading" in list.
4. **Concurrent file reads** → read-only, no lock needed. Partial reads are fine for display.
5. **Dashboard disabled** → `dashboard.enabled: false`, serve only API + webhook routes.
6. **Multiple projects** → project selector dropdown, filter by project.
7. **SSE connection dropped** → client auto-reconnects (built into EventSource API).

## Config

```jsonc
{
  "dashboard": {
    "enabled": true,                      // NEW — default true
    "maxRecentRuns": 50                   // NEW — how many recent runs to show
  }
}
```

## Test Plan

- [ ] Unit: `data.ts` reads and parses state.json files correctly
- [ ] Unit: `data.ts` handles corrupted state files gracefully
- [ ] Unit: `api.ts` returns correct JSON for `/api/runs`
- [ ] Unit: `api.ts` returns correct JSON for `/api/costs`
- [ ] Unit: cost aggregation by project/month/model
- [ ] Unit: SSE pushes events on state file change
- [ ] Unit: pagination works for large run counts
- [ ] Integration: dashboard renders without JavaScript errors
- [ ] Integration: real-time updates via SSE
