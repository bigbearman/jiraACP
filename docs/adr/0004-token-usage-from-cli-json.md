# ADR-0004: Record token usage from the Claude CLI's JSON result

- **Status:** Accepted
- **Date:** 2026-11-16

## Context

The product promise is that the cost of each ticket can be measured, and that `pipeline.maxCostUsdPerRun` stops a run that gets too expensive. Neither worked:

- `runAgent()` ran `claude --print --output-format text`. Text output contains no usage, so no stage wrote `tokenUsage`, `jiraACP usage` was always empty and the cost guard always saw $0.
- `src/utils/pricing.ts` listed none of the model IDs that `runner.ts` sends. Its prices were not from the official page, and unknown models fell back to a default rate.
- Each stage declared a `model` that nothing read. `analyze` declared `sonnet` and called Haiku. Fetch, clarify, git, deploy and notify declared `haiku` but make no LLM call.

All calls go through the Claude Code CLI rather than the API, because the code stage needs Claude Code's tool loop (see ADR-0001). Whatever we choose has to work with that.

## Options considered

### Where the numbers come from

1. **`--output-format json`.** One JSON object at the end of the call: `result` (the text), `usage`, `modelUsage` (per model, subagents included) and `total_cost_usd`. It is a small change, and the call already returned only at the end in text mode.
2. **`--output-format stream-json --verbose`.** Per-step events and live progress. Per-step `output_tokens` is a placeholder, so the totals still come from the final `result` event. It means more parsing for no extra accuracy.
3. **Call the Messages API directly.** Exact usage per request, but the code stage would lose Claude Code's tool loop. Out of scope.
4. **Estimate tokens from text length.** Rejected: the requirement is to measure, not to guess.

### How a stage reports usage

1. **Change `runAgent()` to return `{ text, usage }`** and make every stage add `tokenUsage` to its own output. Every stage then has to sum its own calls (analyze retry, two review agents, test retries), and every test mock of `runAgent` changes.
2. **Pass a usage sink in.** `runAgent()` keeps returning text and reports usage to `opts.usage`. The orchestrator owns one `UsageRecorder`, gives it to stages as `ctx.usage`, and drains it after each stage onto `STAGE_COMPLETED` (or `STAGE_FAILED`).

### What sets the price

1. **The CLI's `total_cost_usd`.** It is free, but it comes from a price table bundled with the CLI version, which we cannot check or pin.
2. **Our own table** in `src/utils/pricing.ts`, holding only the IDs we send, with prices copied from the official page and the lookup date written down. The CLI figure is stored next to ours as a cross-check.

## Decision

- Use `--output-format json`. Read `modelUsage` for real model IDs and per-model tokens, and fall back to `usage` under the requested model when `modelUsage` is missing.
- Report usage through a sink (`ctx.usage`). The orchestrator sums each stage's calls and writes `tokenUsage` on the stage event. Usage is recorded before `runAgent()` throws, so failed calls count.
- Price from `src/utils/pricing.ts`, and store `costUsd` on the event at run time. For a model missing from the table, use the CLI's per-model estimate and mark it `"cli"`. If there is none, count 0, mark it `"none"`, and list it in `jiraACP usage`. Never borrow another model's price.
- Scope the cost guard to the current run (events since the latest `STARTED`), counting completed and failed stages. Abort through the normal abort path: one `PIPELINE_ABORTED`, and the completed stage is not marked failed.
- The `model` field on a stage is the model it calls: each LLM stage uses one constant for both. `analyze` keeps calling Haiku (ADR-0001) and now declares it. The code stage passes its declared model to `detectComplexity()` as the base, so escalation to Opus stays explicit. Stages that call no LLM declare no model (`model` is now optional).

## Consequences

- `jiraACP usage` reports cost per project, ticket and stage, and the cost guard can abort.
- Stored costs reflect the prices on the day of the run. When a model ID changes in `runner.ts`, its price must be added to `pricing.ts`. A test fails if any ID in `MODEL_IDS` has no price.
- Known gaps, listed in [docs/token-cost.md](../token-cost.md): cache writes are priced at the 5-minute rate because `modelUsage` gives no 5m/1h split (the top-level `usage` does, but only for the main loop); data residency, Batch and fast-mode pricing are not modelled; triage usage is not persisted; a call still running when its stage times out is lost; the guard runs between stages, so it cannot stop one expensive stage halfway.
- If the CLI output is not JSON, `runAgent()` still returns the raw text and logs a warning, but that call's cost is lost. This is the trade-off for not failing a run over a reporting problem.
