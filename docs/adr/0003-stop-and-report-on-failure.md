# ADR-0003: Stop and report on failure

- **Status:** Accepted (retrospective; documents existing behaviour)
- **Date:** 2026-11-16

## Context

Every stage has side effects: commits, pushes, PRs, merges, deploys, Jira transitions. If the pipeline keeps going after a failure, or retries blindly, it can stack more side effects on top of a broken state, for example deploying a branch whose tests failed or moving a ticket to Done after a failed merge. Runs are unattended, so the person has to find out a run failed without polling a terminal.

## Options considered

1. **Retry every stage automatically** with backoff. This hides flaky failures, but it repeats side effects (double pushes, duplicate PRs) and burns tokens on failures that are not transient.
2. **Skip the failed stage and continue.** The run completes, but later stages then work on top of a broken state.
3. **Stop at the first failure, record it, notify, and allow a manual resume.** Retry only inside stages where retrying is safe and side-effect free.

## Decision

Option 3. In `runPipeline()` (`src/pipeline/orchestrator.ts`):

1. A thrown error in a stage writes `STAGE_FAILED { stage, error }` and sends a Telegram "stage failed" message.
2. The run then writes `PIPELINE_ABORTED { reason }`, sends an error summary to Telegram, and sets exit code 1.
3. In a `finally` block, the `afterPipeline` hook runs and the per-ticket lock is released, so a failure never leaves a zombie lock.
4. `jiraACP resume <KEY>` restarts from the failed stage, using the event log to rebuild context.

There are some deliberate exceptions inside stages:

- **analyze** retries its parse once with a stricter prompt, then falls back to regex, then to a default score. Bad JSON should not stop a run.
- **test** retries up to `test.retries` times (default 2). A test failure does not stop the run unless `pipeline.failOnTestFailure` is set.
- **deploy** runs `deploy.rollbackCommand` when the deploy or health check fails, writes `DEPLOY_ROLLED_BACK` and notifies.
- **clarify** timing out with `skip` writes `STAGE_SKIPPED` and ends the run cleanly instead of failing.
- **cost guard**: when `pipeline.maxCostUsdPerRun` is set, the run warns at 80% and aborts at 100%.

## Consequences

- A failed run always leaves an explicit record (`STAGE_FAILED` and `PIPELINE_ABORTED`), a Telegram message and a released lock.
- Recovery is manual by design: a person decides whether to `resume`.
- **Gaps in the current code:**
  - Per-stage timeouts use `Promise.race`. A stage that times out is reported as failed, but its work is not cancelled.
  - The cost guard reads `tokenUsage`, which no stage records yet, so it never triggers (see [ADR-0001](0001-model-selection-by-cost.md)).
  - A clarify `skip` stops the run without a `PIPELINE_ABORTED` event, so it looks different from a failure in `status`.
