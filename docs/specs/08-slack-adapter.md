# Feature 08 — Slack Adapter

> Priority: Tier 2 (expansion) · Size: M · Sprint 6

## Problem

jiraACP currently supports only Telegram for human-in-the-loop interactions (clarification, review approval, notifications). Many teams use Slack as primary workspace. No path to add Slack without duplicating Telegram-specific code scattered across stages and integrations.

## Solution

1. Extract a `NotificationAdapter` interface from current Telegram implementation
2. Implement `SlackAdapter` using `@slack/bolt`
3. Support `telegram`, `slack`, or `both` via config
4. Each adapter handles: notifications, clarification human-loop, review approval buttons

## CLI / Config

```bash
jiraACP init    # wizard now asks: "Notification channel: Telegram / Slack / Both"
```

```jsonc
{
  "notifications": {
    "channels": ["telegram"],             // NEW — array: ["telegram"], ["slack"], ["telegram", "slack"]
    
    "telegram": {                         // existing, nested under key
      "botToken": "env:TELEGRAM_BOT_TOKEN",
      "chatId": -1001234567890
    },

    "slack": {                            // NEW
      "botToken": "env:SLACK_BOT_TOKEN",
      "signingSecret": "env:SLACK_SIGNING_SECRET",
      "channel": "#dev-pipeline",
      "threadPerTicket": true             // each ticket gets its own thread
    }
  }
}
```

## Architecture

### New files

| File | Purpose |
|------|---------|
| `src/integrations/notifications/adapter.ts` | `NotificationAdapter` interface + `NotificationRouter` |
| `src/integrations/slack/client.ts` | Slack API wrapper using `@slack/bolt` |
| `src/integrations/slack/notifier.ts` | `SlackNotifier` implementing `NotificationAdapter` |
| `src/integrations/slack/human-loop.ts` | Slack Block Kit buttons for approval/clarification |

### Modified files

| File | Change |
|------|--------|
| `src/integrations/telegram/notifier.ts` | Implement `NotificationAdapter` interface (refactor, no behavior change) |
| `src/integrations/telegram/human-loop.ts` | Implement `HumanLoopAdapter` interface |
| `src/pipeline/stages/3-clarify.ts` | Use `NotificationRouter` instead of direct Telegram calls |
| `src/pipeline/stages/6-review.ts` | Use `NotificationRouter` for approval |
| `src/pipeline/stages/9-notify.ts` | Use `NotificationRouter` for done notifications |
| `src/config/schema.ts` | Add `notifications.channels`, `notifications.slack` schema |
| `src/commands/init.ts` | Add Slack option to setup wizard |
| `package.json` | Add `@slack/bolt` dependency |

### NotificationAdapter interface

```typescript
interface NotificationAdapter {
  readonly platform: "telegram" | "slack";

  sendProgress(ticket: string, stage: string, message: string): Promise<void>;
  sendStageComplete(ticket: string, stage: string, result: StageResult): Promise<void>;
  sendError(ticket: string, error: StageError): Promise<void>;
  sendDone(ticket: string, summary: RunSummary): Promise<void>;

  requestClarification(
    ticket: string,
    questions: ClarificationQuestion[],
  ): Promise<ClarificationResponse>;

  requestApproval(
    ticket: string,
    issues: ReviewIssue[],
  ): Promise<ApprovalResponse>;

  sendReminder(ticket: string, context: ReminderContext): Promise<void>;
}

class NotificationRouter {
  private adapters: NotificationAdapter[];

  /** Broadcasts to all configured channels */
  async broadcast(fn: (adapter: NotificationAdapter) => Promise<void>): Promise<void>;

  /** Sends human-loop request to PRIMARY channel only (first in config) */
  async requestHumanInput<T>(
    fn: (adapter: NotificationAdapter) => Promise<T>,
  ): Promise<T>;
}
```

### Slack specifics

- **Threads**: Each ticket gets its own Slack thread (if `threadPerTicket: true`)
- **Block Kit**: Approval buttons rendered as Slack Block Kit interactive components
- **Clarification**: Structured reply via Slack modal (triggered by button click)
- **Socket Mode**: Uses `@slack/bolt` Socket Mode — no public URL needed (unlike Slack Events API)

### Slack message format

```
📋 PROJ-123: Add user authentication
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Stage 6/9: Review ✅
• Logic review: 0 major, 2 minor issues
• Quality review: 1 major issue

[✅ Approve] [❌ Reject] [📄 View Issues]
```

## Migration

Existing users with Telegram config only:
- Config automatically wrapped under `notifications.telegram`
- `notifications.channels` defaults to `["telegram"]`
- Zero breaking changes

## Edge Cases

1. **Both channels configured** → broadcast notifications to both. Human-loop uses primary (first in array).
2. **Slack token invalid** → `doctor` detects, suggests fix. Pipeline falls back to other channel if available.
3. **Thread not found** (deleted) → create new thread, log warning.
4. **User responds on wrong channel** → only primary channel's response is accepted.
5. **Slack rate limit** → exponential backoff, same pattern as Telegram.
6. **Socket Mode disconnected** → auto-reconnect (built into `@slack/bolt`).
7. **No notification channel configured** → pipeline runs without notifications (log-only mode).

## Dependencies

- `@slack/bolt` (~0.5MB, well-maintained)
- Socket Mode requires Slack app with `connections:write` scope

## Test Plan

- [ ] Unit: `NotificationRouter` broadcasts to all adapters
- [ ] Unit: `NotificationRouter` sends human-loop to primary only
- [ ] Unit: `SlackNotifier` formats messages with Block Kit
- [ ] Unit: `SlackNotifier.requestApproval()` returns approve/reject
- [ ] Unit: `SlackNotifier.requestClarification()` returns structured answers
- [ ] Unit: thread creation and reuse for same ticket
- [ ] Unit: config migration from flat Telegram to nested notifications
- [ ] Unit: fallback when one channel fails
- [ ] Integration: existing Telegram tests pass unchanged after refactor
