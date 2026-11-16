# ADR-0002: Human approval through Telegram

- **Status:** Accepted (retrospective; documents existing behaviour)
- **Date:** 2026-11-16

## Context

The pipeline writes code and can merge it. There are two points where a person's judgement is worth more than another model call:

1. **Before coding**, when the ticket is too vague to implement correctly.
2. **Before merging**, when the AI reviewers report serious problems.

The people who need to answer are small-team developers or leads who are usually not at a terminal. A run can also take a long time (CI, review), so the pipeline must be able to wait for hours without anyone watching it.

## Options considered

1. **Interactive CLI prompts.** No extra service, but the person has to sit at the terminal and the process has to stay in the foreground.
2. **GitHub PR reviews as the gate.** This fits the merge step well, but it says nothing about clarifying a ticket before coding, and it is noisy on mobile.
3. **Slack.** Common in companies, but it needs workspace admin approval and an app installation.
4. **A Telegram bot.** One bot token, works on any phone, supports inline buttons and threads (forum topics), and works well for a solo developer or a small team.

## Decision

Option 4, with two gates (`src/integrations/telegram/human-loop.ts`):

| Gate | Trigger | Human action | Timeout behaviour (configurable) |
|------|---------|--------------|----------------------------------|
| Clarify (stage 3) | Clarity score < `jira.clarityScoreThreshold` (0.7) | Reply `/answer <KEY> ...` | After `clarificationTimeoutMs` (1 h; one reminder at 50%): `skip` (default; the run stops without coding), `abort`, or `proceed-with-warning` |
| Review (stage 6) | Major issues ≥ `github.majorIssueThreshold` (1) | Approve / Reject buttons, or `/approve`, `/reject` | Reminders every 30 min, up to 3; after 24 h: `abort` (default) or `merge-anyway` |

Each request writes an event to the run log (`HUMAN_APPROVAL_REQUESTED`, `APPROVAL_REMINDER_SENT`, `HUMAN_APPROVED` / `HUMAN_REJECTED`), so waiting time can be audited. Only messages from the configured `chatId` are accepted.

## Consequences

- People answer from their phone, and the pipeline can wait for a long time without blocking a terminal.
- Telegram becomes a hard dependency for any run that needs a decision.
- **The review gate is conditional.** When the two AI reviewers report fewer major issues than the threshold, **the PR is merged without any human approval**. This is deliberate for speed, but it means "human-approved" is not true for every merge. Teams that want a human on every merge should set `github.majorIssueThreshold` to `0`.
- In `--dry-run` the approval is treated as granted, so dry runs do not exercise the gate.
- **Follow-ups:** consider making "always require approval" the default for new projects; add a GitHub PR review as an alternative gate.
