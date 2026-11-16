# Token cost per ticket

**Status: not measured yet.** The pipeline records token usage and cost for every stage that calls Claude (see below), but no ticket has been run end to end with a real API key yet. The table stays empty until a real run's state log fills it. Nothing here is estimated.

## Measured cost per ticket

| Stage | Model | Calls per run | Input tokens | Output tokens | Cache write | Cache read | Cost (USD) |
|-------|-------|---------------|--------------|---------------|-------------|------------|------------|
| 2 analyze | Haiku | 1 (2 if the first reply is not valid JSON) | not measured | not measured | not measured | not measured | not measured |
| 4 code | Sonnet (Opus for complex tickets) | 1 agent session | not measured | not measured | not measured | not measured | not measured |
| 6 review | Sonnet | 2 (logic and quality, in parallel) | not measured | not measured | not measured | not measured | not measured |
| 8 test | Sonnet | 0 when `test.enabled` is false (default); otherwise 1 + up to `test.retries` | not measured | not measured | not measured | not measured | not measured |
| **Total** | | **4–5** with defaults | **not measured** | **not measured** | **not measured** | **not measured** | **not measured** |

Stages 1 fetch, 3 clarify, 5 git, 7 deploy and 9 notify make no LLM calls and record no usage.

The call counts come from the code. The model column is the `model` each stage declares, which is also the model it calls (`src/pipeline/stages/*.ts`).

## How usage is recorded

1. `runAgent()` (`src/pipeline/runner.ts`) runs `claude --model <id> --print --output-format json`. The JSON result carries the text reply in `result`, plus `modelUsage`, `usage` and `total_cost_usd`.
2. `parseAgentResult()` (`src/pipeline/token-usage.ts`) reads `modelUsage`: input, output, cache-write and cache-read tokens per **real model ID**, subagent calls included. If `modelUsage` is missing, it falls back to the top-level `usage` and attributes it to the requested model.
3. Each stage passes `ctx.usage` to `runAgent()`. The orchestrator owns one `UsageRecorder` per run and drains it after each stage, so a stage that calls Claude several times (analyze retry, two review agents, test retries) gets one summed record.
4. The orchestrator writes that record as `output.tokenUsage` on `STAGE_COMPLETED`. If the stage fails after spending tokens, the record goes on `STAGE_FAILED` as `tokenUsage`. Usage is recorded even when the CLI exits non-zero, because the tokens were still spent.

A `tokenUsage` record looks like this (the numbers are illustrative, not measured):

```json
{
  "model": "claude-sonnet-4-6",
  "inputTokens": 1200,
  "outputTokens": 800,
  "cacheCreationInputTokens": 3000,
  "cacheReadInputTokens": 45000,
  "costUsd": 0.04035,
  "calls": 2,
  "cliReportedCostUsd": 0.0404,
  "byModel": {
    "claude-sonnet-4-6": {
      "inputTokens": 1200, "outputTokens": 800,
      "cacheCreationInputTokens": 3000, "cacheReadInputTokens": 45000,
      "costUsd": 0.04035, "pricing": "table"
    }
  }
}
```

`model` is the model with the most tokens in that stage. `byModel` keeps every model the CLI reported, for example a Haiku side call inside a Sonnet session.

## How cost is computed

- `costUsd` is computed when the stage finishes, from `src/utils/pricing.ts`, and stored with the event. Later price changes do not rewrite past runs.
- `src/utils/pricing.ts` lists only the model IDs that `runner.ts` sends. The prices come from the [official pricing page](https://platform.claude.com/docs/en/about-claude/pricing), looked up on 2026-11-16:

  | Model ID | Input | Output | Cache write (5 min) | Cache read |
  |----------|-------|--------|---------------------|------------|
  | `claude-haiku-4-5-20251001` | $1 / MTok | $5 / MTok | $1.25 / MTok | $0.10 / MTok |
  | `claude-sonnet-4-6` | $3 / MTok | $15 / MTok | $3.75 / MTok | $0.30 / MTok |
  | `claude-opus-4-6` | $5 / MTok | $25 / MTok | $6.25 / MTok | $0.50 / MTok |

- If the CLI reports a model that is not in the table, the CLI's own per-model estimate (`costUSD`) is used, and the model is marked `"pricing": "cli"`. If no estimate is available either, its cost counts as 0 and it is marked `"pricing": "none"`. `jiraACP usage` lists such models under the report. No price is ever borrowed from another model.
- `cliReportedCostUsd` is the CLI's `total_cost_usd`, stored next to our figure as a cross-check.

## Cost guard

When `pipeline.maxCostUsdPerRun` is set, the orchestrator sums `costUsd` over the current run after each completed stage. The current run means the events since the latest `STARTED`, including failed stages. If the sum reaches the limit, it sends a Telegram message, records one `PIPELINE_ABORTED` ("Cost limit exceeded after <stage> …"), and runs no further stages. At 80% of the limit it sends a warning and continues. A resumed or retried ticket starts a new run and gets a fresh budget.

The guard runs between stages, so it cannot stop a stage halfway. A single expensive code session can overshoot the limit before the guard sees it.

## Reading the numbers

```bash
jiraACP usage                       # per project and ticket, plus a per-stage table
jiraACP usage --verbose             # adds per-stage rows under each ticket
jiraACP usage --ticket PROJ-123     # one ticket
jiraACP usage --month 2026-11 --project my-project
```

The raw records are in `~/.jira-acp/runs/<project>/<ticket>/state.json`.

## Known limits

- **Estimates, not a bill.** Costs are API list prices times reported tokens. With a Claude subscription login, the CLI still reports tokens, but what you actually pay depends on your plan.
- **Cache writes are priced at the 5-minute rate.** The per-model `modelUsage` has one cache-write figure, with no 5-minute/1-hour split. The top-level `usage` has the split, but it covers only the main loop and names no model, so it is not used for pricing. If 1-hour caching is enabled (`ENABLE_PROMPT_CACHING_1H`, or a subscription that uses it), cache writes cost up to 1.6× what is shown.
- **Not modelled:** data residency (`inference_geo: "us"`, 1.1×), Batch discounts, fast mode and per-request tool fees such as web search.
- **Triage** (`jiraACP triage`) runs the analyze stage outside a pipeline run, so its tokens are not written to any state log.
- **Unparseable output.** If the CLI output is not JSON (for example an old CLI version), the call still works, but its usage is lost and a warning is logged.
- **Timeouts.** A stage that hits its stage timeout loses the usage of the call still in flight.

## How to fill in the table

1. Get an API key approved for the measurement and a test repository with a small ticket.
2. Run the ticket end to end: `jiraACP run <TICKET>`.
3. Copy the per-stage numbers from `jiraACP usage --ticket <TICKET> --verbose` into the table above. Add the date, ticket size and repository, and the CLI version (`claude --version`).
