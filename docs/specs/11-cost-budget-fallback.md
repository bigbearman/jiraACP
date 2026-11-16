# Feature 11 — Cost Budget Tier with Model Fallback

> Priority: Tier 3 (strategic) · Size: S · Sprint 7

## Problem

When `maxCostUsdPerRun` is hit, the pipeline aborts immediately — wasting all tokens spent up to that point. For a $2 run that hits the $3 limit at stage 6, aborting means $2 thrown away. A completed run at lower quality is more valuable than an aborted one.

## Solution

Instead of hard abort, implement a tiered cost response:
1. **Warn** at configurable threshold (e.g., 70% budget)
2. **Downgrade model** when approaching limit (opus → sonnet → haiku)
3. **Abort only** as last resort when even haiku would exceed budget

## Config

```jsonc
{
  "costGuard": {
    "maxCostUsdPerRun": 5.00,            // existing
    "warnThreshold": 0.7,                // NEW — warn at 70% (default 0.7)
    "downgradeThreshold": 0.85,          // NEW — downgrade model at 85% (default 0.85)
    "abortThreshold": 0.95,              // NEW — hard abort at 95% (default 0.95)
    "fallbackChain": ["opus", "sonnet", "haiku"],  // NEW — downgrade order
    "allowDowngrade": true               // NEW — default true
  }
}
```

## Architecture

### Modified files

| File | Change |
|------|--------|
| `src/pipeline/cost-guard.ts` | Add tier logic: warn → downgrade → abort |
| `src/pipeline/orchestrator.ts` | Check cost tier before each stage, adjust model selection |
| `src/integrations/telegram/notifier.ts` | Add warn/downgrade notification messages |
| `src/pipeline/state.ts` | Add `COST_WARNING`, `COST_MODEL_DOWNGRADED` events |
| `src/config/schema.ts` | Add new cost guard fields |

### Cost tier decision

```typescript
type CostAction = "continue" | "warn" | "downgrade" | "abort";

function evaluateCostTier(
  spent: number,
  budget: number,
  config: CostGuardConfig,
): { action: CostAction; currentModel: ModelTier; suggestedModel: ModelTier } {
  const ratio = spent / budget;

  if (ratio >= config.abortThreshold) return { action: "abort", ... };
  if (ratio >= config.downgradeThreshold) return { action: "downgrade", ... };
  if (ratio >= config.warnThreshold) return { action: "warn", ... };
  return { action: "continue", ... };
}
```

### Model downgrade logic

```
Budget: $5.00

Stage 1-3: haiku     → $0.05 (1%)    → continue
Stage 4:   opus      → $2.50 (51%)   → continue
Stage 5:   haiku     → $2.52 (50%)   → continue
Stage 6:   sonnet×2  → $3.80 (76%)   → ⚠️ WARN (>70%)
                                        Telegram: "Cost warning: $3.80/$5.00 (76%)"
Stage 7:   haiku     → $3.82 (76%)   → continue
Stage 8:   sonnet    → approaching 85%
           → DOWNGRADE to haiku
           Telegram: "Cost guard: downgrading stage 8 from sonnet → haiku"
           → $4.10 (82%)
Stage 9:   haiku     → $4.12 (82%)   → continue ✅

Total: $4.12 instead of aborting at $3.80
```

### Integration with stage execution

```typescript
// In orchestrator, before each stage:
const tier = evaluateCostTier(currentCost, budget, config);

switch (tier.action) {
  case "continue":
    runStage(stage, stage.defaultModel);
    break;

  case "warn":
    await notifyTelegram(`⚠️ Cost: $${currentCost}/$${budget}`);
    runStage(stage, stage.defaultModel);
    break;

  case "downgrade":
    const downgraded = getNextLowerModel(stage.defaultModel, config.fallbackChain);
    await notifyTelegram(`📉 Downgrading ${stage.name}: ${stage.defaultModel} → ${downgraded}`);
    emit(COST_MODEL_DOWNGRADED, { stage, from: stage.defaultModel, to: downgraded });
    runStage(stage, downgraded);
    break;

  case "abort":
    emit(COST_ABORT, { spent: currentCost, budget });
    throw new CostLimitError(`Budget exhausted: $${currentCost}/$${budget}`);
}
```

## Events

| Event | Data |
|-------|------|
| `COST_WARNING` | `{ spent, budget, ratio, stage }` |
| `COST_MODEL_DOWNGRADED` | `{ stage, fromModel, toModel, spent, budget }` |
| `COST_ABORT` | `{ spent, budget, ratio }` (existing, preserved) |

## Edge Cases

1. **`allowDowngrade: false`** → skip downgrade tier, go straight to abort. Current behavior.
2. **Already using haiku** (lowest model) → cannot downgrade further → abort.
3. **Stage requires specific model** (e.g., review needs sonnet for quality) → config can override with `review.minModel: "sonnet"`. If can't meet minimum → abort.
4. **Cost estimation inaccurate** → tiers are checked before AND after each stage. If stage unexpectedly costs more, abort happens post-stage.
5. **Dry-run** → cost calculation runs but no real API calls → no real spend.
6. **Multiple downgrades in one run** → cumulative. opus→sonnet→haiku across stages is valid.

## Test Plan

- [ ] Unit: `evaluateCostTier()` returns "continue" below warn threshold
- [ ] Unit: `evaluateCostTier()` returns "warn" at 70%
- [ ] Unit: `evaluateCostTier()` returns "downgrade" at 85%
- [ ] Unit: `evaluateCostTier()` returns "abort" at 95%
- [ ] Unit: model downgrade follows fallback chain order
- [ ] Unit: already-lowest model → abort instead of downgrade
- [ ] Unit: `allowDowngrade: false` → direct abort
- [ ] Unit: `COST_WARNING` and `COST_MODEL_DOWNGRADED` events emitted
- [ ] Unit: Telegram receives warn and downgrade messages
- [ ] Integration: full pipeline completes with downgraded models under budget
