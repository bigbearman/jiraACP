# Token cost per ticket

**Status: not measured yet.**

This page will hold the measured token usage and cost of one ticket run end to end. The numbers are intentionally empty: none have been measured, and the pipeline does not record token usage today (see below). Numbers will be added only from a real run's state log, not estimated.

## Claude calls per ticket

The call counts come from the code. Token counts are empty until measured.

| Stage | Model | Calls per run | Input tokens | Output tokens | Cost (USD) |
|-------|-------|---------------|--------------|---------------|------------|
| 2 analyze | Haiku | 1 (2 if the first reply is not valid JSON) | not measured | not measured | not measured |
| 4 code | Sonnet (Opus for complex tickets) | 1 agent session | not measured | not measured | not measured |
| 6 review | Sonnet | 2 (logic and quality, in parallel) | not measured | not measured | not measured |
| 8 test | Sonnet | 0 when `test.enabled` is false (default); otherwise 1 + up to `test.retries` | not measured | not measured | not measured |
| **Total** | | **4–5** with defaults | **not measured** | **not measured** | **not measured** |

Stages 1, 3, 5, 7 and 9 make no LLM calls.

## Why there are no numbers yet

- `runAgent()` (`src/pipeline/runner.ts`) calls `claude --print --output-format text`. Text output does not include usage, so no stage puts `tokenUsage` on its `STAGE_COMPLETED` event.
- `jiraACP usage` and the cost guard both read `tokenUsage`, so today they report nothing.
- The pricing table in `src/utils/pricing.ts` does not list the model IDs that `runner.ts` actually uses, so it would fall back to its default rate.

## How to measure

1. Switch `runAgent()` to `--output-format json` and record `usage` (input, output and cache tokens) as `tokenUsage` on each stage's `STAGE_COMPLETED` event.
2. Add the model IDs from `MODEL_IDS` to `src/utils/pricing.ts`.
3. Run one ticket end to end on a test repository, then copy the numbers from `~/.jira-acp/runs/<project>/<ticket>/state.json` (or `jiraACP usage`) into the table above, with the date, ticket size and repository.
