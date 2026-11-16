# Product direction

- **Status:** Current. This document is the source of truth for what `jiraACP` is and is not.
- **Date:** 2026-11-16

## In one sentence

`jiraACP` turns one Jira ticket into **one reviewed pull request**. A person approves every merge, and the cost of each ticket is measured.

It shows how to fit an LLM into a delivery process a team already runs (Jira, GitHub, CI, code review) without giving up control of what ships. It is not an autonomous ticket-to-production bot.

## Who it is for

A tech lead or senior developer on a small team that:

- tracks work in Jira Cloud and keeps code on GitHub with CI,
- has a steady supply of small, well-scoped tickets (bug fixes, small features, chores),
- wants an LLM to do the first draft of those changes, but keeps merge authority with a person,
- needs to know what each ticket costs before using this more widely.

## The problem

Much of the time spent on a routine ticket goes into coordination, not engineering: reading the ticket, working out whether it is clear enough to start, writing the change, opening the PR, waiting for CI, getting a review, and updating Jira afterwards.

Handing all of that to an LLM agent raises two concerns that block adoption:

1. **Control.** Nobody wants an agent merging code that no person has looked at.
2. **Cost.** LLM usage per ticket is hard to predict, and nobody wants a bill that cannot be traced back to a ticket.

## Scope

In scope, matching stages 1–6 and 9 of the pipeline:

| Step | What it does |
|------|--------------|
| Fetch | Read the ticket from Jira |
| Analyze | Score how clear the ticket is (LLM) |
| Clarify | Ask the team on Telegram when the ticket is not clear enough |
| Code | Implement the change on a new branch with Claude Code (LLM) |
| Git / PR / CI | Push, open the PR, request reviewers, wait for CI |
| Review | Two independent AI reviews (LLM), then a **human approval gate** before merge |
| Notify | Update Jira and post the result to Telegram |
| Cost | Record token usage per stage and stop a run that exceeds its cost limit |

## Out of scope

These are deliberately not part of the product. Code or specs for some of them exist in the repository from earlier exploration; see [`docs/archive/`](archive/).

- Merging without a person's approval.
- Deploying by default. The deploy and UI-test stages (7 and 8) stay in the code as opt-in extras, off by default.
- Slack or other chat adapters. Telegram is the only human-in-the-loop channel.
- A plugin system.
- A web dashboard.
- Multi-ticket dependency graphs (running a sprint as a DAG).
- A learning loop that retries automatically using review feedback.

## Principles

### 1. A person approves every merge

The LLM can write and review code, but it cannot decide on its own that code ships. Merging a PR requires an explicit approval from a person through Telegram. See [ADR-0002](adr/0002-human-approval-via-telegram.md).

**Where the code is today:** not yet met. Stage 6 merges automatically when the two AI reviewers report fewer major issues than `github.majorIssueThreshold` (default 1). Making approval mandatory by default is the next change.

### 2. Cost per ticket is measured

Every stage that calls an LLM records the model and its token usage, so the cost of a ticket can be reported and capped. The model is chosen per stage by cost: Haiku for analysis, Sonnet for coding and review, Opus only for tickets that look complex. See [ADR-0001](adr/0001-model-selection-by-cost.md).

**Where the code is today:** not yet met. Model selection per stage is in place. Token usage is not recorded, because the agent runs with `--output-format text`. As a result `jiraACP usage` shows no data and the `pipeline.maxCostUsdPerRun` guard never triggers. See [docs/token-cost.md](token-cost.md).

### 3. Stop and report on failure

When a stage fails, the run stops, records the failure in its event log, tells the person on Telegram and releases its lock. It does not retry steps that have side effects, and it does not carry on past a broken state. A person decides whether to `resume`. See [ADR-0003](adr/0003-stop-and-report-on-failure.md).

**Where the code is today:** met, with the gaps listed in ADR-0003.

## How this document relates to the rest of the repository

- [`README.md`](../README.md) describes what the code does today and its known limitations.
- [`docs/adr/`](adr/) records individual design decisions.
- [`SPEC.md`](../SPEC.md) and [`docs/archive/`](archive/) are earlier planning documents. They are kept for history and are not a roadmap. Where they disagree with this document, this document wins.
