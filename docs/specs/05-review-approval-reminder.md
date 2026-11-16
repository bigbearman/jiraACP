# Feature 05 — Review Approval Reminder

> Priority: Tier 1 (gap fill) · Size: XS · Sprint 4

## Problem

Stage 6 (Review) sends Telegram approval buttons when major issues are found. If the user doesn't respond, the pipeline waits indefinitely until the configured timeout (default 1h). No reminder is sent — the user may forget or miss the notification.

## Solution

Add periodic reminder pings via Telegram while awaiting approval:
1. First reminder after 30 minutes (configurable)
2. Repeat every 30 minutes up to 3 times (configurable)
3. After max reminders, follow `approvalTimeoutAction` config: `abort` (default), `auto-approve`, or `skip-review`

## CLI / Config

```jsonc
{
  "review": {
    "approvalTimeout": 3600000,              // existing — 1h
    "approvalTimeoutAction": "abort",        // existing
    "reminderInterval": 1800000,             // NEW — 30min default (ms)
    "maxReminders": 3                        // NEW — default 3
  }
}
```

## Architecture

### Affected files

| File | Change |
|------|--------|
| `src/pipeline/stages/6-review.ts` | Add reminder timer during approval wait |
| `src/integrations/telegram/human-loop.ts` | Add `sendReminder()` method |
| `src/config/schema.ts` | Add `reminderInterval`, `maxReminders` fields |
| `src/pipeline/state.ts` | Add `APPROVAL_REMINDER_SENT` event |

### Flow

```
awaitApproval():
  sendApprovalMessage(issues)
  reminderCount = 0

  while not resolved AND elapsed < approvalTimeout:
    waitResult = await Promise.race([
      waitForButtonClick(),                        // existing
      sleep(reminderInterval),                     // new timer
    ])

    if waitResult === "button_clicked":
      return waitResult.approved

    if waitResult === "timer":
      reminderCount++
      if reminderCount <= maxReminders:
        sendReminder(ticketKey, reminderCount, maxReminders, elapsed)
        emit(APPROVAL_REMINDER_SENT, { count: reminderCount })

  // timeout reached
  return handleTimeoutAction(approvalTimeoutAction)
```

### Reminder message template

```
🔔 Reminder (2/3): PROJ-123 review approval pending

3 major issues found — waiting for your decision.
⏱️ Elapsed: 1h 0m — auto-abort in 30m

[✅ Approve] [❌ Reject]
```

## Edge Cases

1. **User approves before first reminder** → no reminders sent. Clean path.
2. **`reminderInterval > approvalTimeout`** → no reminders ever sent. Same as current behavior.
3. **`maxReminders: 0`** → reminders disabled. Timeout action applies directly.
4. **User approves between reminders** → cancel pending timer immediately.
5. **Telegram rate limit** → catch error, log warning, skip this reminder cycle.
6. **`approvalTimeoutAction: "auto-approve"`** → after timeout, pipeline continues as if approved. Log warning.
7. **`approvalTimeoutAction: "skip-review"`** → skip review stage entirely, proceed to deploy.

## Test Plan

- [ ] Unit: reminder sent at correct interval
- [ ] Unit: no reminder if approved before interval
- [ ] Unit: max reminders respected (stops after N)
- [ ] Unit: `APPROVAL_REMINDER_SENT` event emitted with count
- [ ] Unit: timer cancelled on approval
- [ ] Unit: `maxReminders: 0` → no reminders
- [ ] Unit: timeout action `auto-approve` works
- [ ] Unit: timeout action `skip-review` works
- [ ] Unit: reminder message includes correct count and time remaining
