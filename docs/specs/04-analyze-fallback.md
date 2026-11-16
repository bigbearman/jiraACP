# Feature 04 — Analyze Stage Fallback Strategy

> Priority: Tier 1 (gap fill) · Size: XS · Sprint 4

## Problem

Stage 2 (Analyze) asks a Claude agent to return a JSON clarity score (0.0–1.0). If the agent returns unparseable JSON, the current code defaults to score `0` — which always triggers stage 3 (Clarify). This creates unnecessary Telegram messages and delays the pipeline for tickets that are actually clear.

## Solution

1. **Retry once** with explicit structured output instructions if first parse fails
2. **Default to 0.5** (not 0) if retry also fails → allows pipeline to proceed with a warning
3. Emit a `ANALYZE_PARSE_FALLBACK` event so operators can audit

## Architecture

### Affected files

| File | Change |
|------|--------|
| `src/pipeline/stages/2-analyze.ts` | Add retry logic + fallback score 0.5 |
| `src/pipeline/state.ts` | Add `ANALYZE_PARSE_FALLBACK` event type |
| `src/integrations/telegram/notifier.ts` | Add warning message for fallback |

### Flow

```
analyzeTicket():
  response = await runAgent(analyzePrompt)

  try:
    result = parseJSON(response)        // try 1
    return result
  catch:
    // retry with explicit format instructions
    retryPrompt = `${analyzePrompt}\n\nIMPORTANT: Return ONLY valid JSON: {"score": 0.7, "missing": [...], "questions": [...]}`
    response2 = await runAgent(retryPrompt)

    try:
      result = parseJSON(response2)     // try 2
      return result
    catch:
      emit(ANALYZE_PARSE_FALLBACK, { rawResponse: response2.slice(0, 500) })
      notifyTelegram("⚠️ Clarity analysis parse failed, using default score 0.5")
      return { score: 0.5, missing: [], questions: [] }
```

### Configurable threshold interaction

```jsonc
{
  "pipeline": {
    "clarityThreshold": 0.6,            // existing field
    "analyzeFallbackScore": 0.5         // NEW — default 0.5
  }
}
```

- If `analyzeFallbackScore >= clarityThreshold` → clarify stage is SKIPPED (pipeline proceeds)
- If `analyzeFallbackScore < clarityThreshold` → clarify stage triggers (current behavior for score 0)
- Default 0.5 < default threshold 0.6 → clarify still triggers by default, but can be tuned

## Edge Cases

1. **First parse succeeds** → no retry, no fallback. Current happy path unchanged.
2. **Retry succeeds** → use retry result. No fallback event.
3. **Both fail** → fallback score. Telegram warning. Pipeline continues.
4. **Agent returns partial JSON** → try to extract score with regex `"score"\s*:\s*([\d.]+)` before giving up.
5. **Dry-run** → still runs analysis (no side effects), same retry behavior.

## Test Plan

- [ ] Unit: valid JSON on first try → returns parsed result, no retry
- [ ] Unit: invalid JSON on first try, valid on retry → returns retry result
- [ ] Unit: both attempts fail → returns `{ score: 0.5, missing: [], questions: [] }`
- [ ] Unit: `ANALYZE_PARSE_FALLBACK` event emitted on double failure
- [ ] Unit: partial JSON with extractable score → uses extracted score
- [ ] Unit: `analyzeFallbackScore` config respected
- [ ] Unit: Telegram warning sent on fallback
