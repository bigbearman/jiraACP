# ADR-0001: Choose the Claude model per stage by cost

- **Status:** Accepted (retrospective; documents existing behaviour)
- **Date:** 2026-11-16

## Context

A single ticket can trigger up to five Claude calls: analyze (1–2), code (1), review (2), and test (1 or more, only when enabled). These calls do very different kinds of work:

- **Analyze** produces a small JSON clarity score from a ticket. It is short, structured and low-stakes, since a wrong score only leads to an extra clarification question.
- **Code** edits a real repository over many tool-use turns. It is by far the longest call, and its quality decides whether the run is worth anything.
- **Review** reads a diff and lists issues. Its quality matters because it gates the merge (see [ADR-0002](0002-human-approval-via-telegram.md)).

Running every call on the most capable model would waste money on the simple steps. Running every call on the cheapest model would hurt the code and review steps, which are the ones users judge.

## Options considered

1. **One model for everything** (for example Sonnet). This is the simplest option, but it overpays on analyze and has no headroom for hard tickets.
2. **A fixed model per stage, chosen by how hard and how important the work is.** Cheap where errors are cheap, stronger where they are expensive.
3. **A fixed model per stage, plus escalation for hard tickets.** Same as option 2, but the code stage moves to the most capable model when the ticket looks complex.
4. **Dynamic routing** based on measured difficulty or a classifier call. This could be more precise, but it adds an extra call, more complexity, and needs data we don't have yet.

## Decision

Option 3.

| Stage | Model | Why |
|-------|-------|-----|
| analyze | Haiku | Short structured output; mistakes are cheap and recoverable through clarify |
| code | Sonnet, escalated to Opus | Main value step; Opus when the ticket matches 2 or more "complex" keywords |
| review (×2) | Sonnet | Must catch real problems, but reads a bounded diff |
| test | Sonnet | Drives Playwright; needs tool use, not deep reasoning |

Escalation is done by `detectComplexity()` in `src/pipeline/runner.ts`. It switches to Opus when the ticket text contains at least two of: `auth`, `payment`, `stripe`, `oauth`, `jwt`, `migration`, `schema`, `database`, `refactor`, `cross-module`, `multi-service`, `security`, `encryption`, `permission`.

Model IDs are mapped in one place (`MODEL_IDS` in `src/pipeline/runner.ts`). All calls go through the Claude Code CLI (`claude --model <id> --print`), not the API directly. That way the code stage gets Claude Code's file editing and tool loop for free.

## Consequences

- Cheap stages stay cheap without any configuration.
- The keyword heuristic is crude: it can miss hard tickets that use none of the words, and it can escalate simple tickets that mention two of them.
- **Gaps in the current code:**
  - Each stage declares a `model` field (`src/pipeline/stages/types.ts`), but nothing reads it. The model actually used is hard-coded in each stage. For example, `analyze` declares `sonnet` but calls Haiku.
  - Models cannot be chosen per project in config.
  - Token usage is not captured (the CLI runs with `--output-format text`), so the cost savings this ADR aims for cannot be measured yet. See [docs/token-cost.md](../token-cost.md).
- **Follow-ups:** read the model from config with these defaults; switch to `--output-format json` and record `tokenUsage` on `STAGE_COMPLETED`; then revisit the escalation rule using real cost and quality data.
