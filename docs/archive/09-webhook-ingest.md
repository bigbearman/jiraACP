> **Archived idea, not a roadmap.** The current direction is in [docs/PRODUCT.md](../PRODUCT.md). **Status: not planned.** `jiraACP serve` has a basic `POST /webhook/jira` endpoint; the rest of this spec is not implemented.

# Feature 09 — Jira Webhook Auto-Trigger

> Priority: Tier 2 (automation) · Size: M · Sprint 6

## Problem

Currently, pipeline runs are manually triggered via `jiraACP run PROJ-123` or scheduled via cron. The `serve` command exists but only provides a basic HTTP server without webhook processing. True automation requires reacting to Jira events — when a ticket moves to "Ready for Dev", the pipeline should start automatically.

## Solution

Implement Jira webhook ingestion in the existing `serve` command:
1. Listen for Jira webhook POST events
2. Filter by: status transition, assignee, project
3. Auto-trigger `run` for matching tickets
4. Verify webhook authenticity (HMAC or IP allowlist)
5. Rate-limit per ticket to prevent duplicate triggers

## CLI / Config

```bash
# Existing command — gains webhook functionality
jiraACP serve [--port 3110]

# Setup: register webhook in Jira
jiraACP webhook register --project <name>     # NEW — auto-creates Jira webhook
jiraACP webhook list                          # NEW — show registered webhooks
jiraACP webhook remove <id>                   # NEW — remove webhook from Jira
```

```jsonc
{
  "webhook": {
    "enabled": true,                          // NEW — default false
    "secret": "env:JIRA_WEBHOOK_SECRET",      // NEW — HMAC verification
    "triggerOnStatus": ["Ready for Dev"],      // NEW — status names that trigger pipeline
    "triggerOnAssignee": true,                 // NEW — only if assigned to configured user
    "rateLimitPerTicket": 3600000,             // NEW — 1h cooldown per ticket (ms)
    "allowedIPs": [],                         // NEW — optional IP allowlist (empty = any)
    "autoRun": {
      "dryRun": false,                        // NEW — dry-run mode for webhook triggers
      "stages": { "from": "fetch", "to": "notify" }  // NEW — stage range
    }
  }
}
```

## Architecture

### New files

| File | Purpose |
|------|---------|
| `src/commands/webhook.ts` | CLI handlers for `webhook register/list/remove` |
| `src/webhook/handler.ts` | `WebhookHandler` — validates, filters, and dispatches events |
| `src/webhook/validator.ts` | HMAC signature verification + IP allowlist |
| `src/webhook/rate-limiter.ts` | Per-ticket rate limiting with in-memory + file-backed state |

### Modified files

| File | Change |
|------|--------|
| `src/cli.ts` | Register `webhook` command group |
| `src/commands/serve.ts` | Mount webhook route `POST /webhook/jira` |
| `src/integrations/jira/client.ts` | Add `createWebhook()`, `listWebhooks()`, `deleteWebhook()` |
| `src/pipeline/state.ts` | Add `WEBHOOK_TRIGGERED`, `WEBHOOK_RATE_LIMITED` events |
| `src/config/schema.ts` | Add `webhook` config section |

### Webhook route

```
POST /webhook/jira
  Headers:
    X-Atlassian-Webhook-Identifier: <id>
    X-Hub-Signature: sha256=<hmac>         (if secret configured)

  Body (Jira webhook payload):
    {
      "webhookEvent": "jira:issue_updated",
      "issue": { "key": "PROJ-123", ... },
      "changelog": {
        "items": [{ "field": "status", "toString": "Ready for Dev" }]
      }
    }
```

### WebhookHandler flow

```
handleWebhook(req):
  1. Validate signature (HMAC or IP allowlist)
     → 401 if invalid

  2. Parse Jira event
     → 400 if malformed

  3. Filter:
     a. Is event a status transition? → extract new status
     b. Is new status in triggerOnStatus? → skip if not
     c. Is assignee matching? (if triggerOnAssignee) → skip if not
     d. Is ticket's project in known projects? → skip if not

  4. Rate limit check
     → 429 if ticket triggered within rateLimitPerTicket window

  5. Dispatch pipeline run (async, non-blocking)
     → respond 202 Accepted immediately
     → run pipeline in background

  6. Emit WEBHOOK_TRIGGERED event
     → Telegram: "🔔 Webhook trigger: PROJ-123 → Ready for Dev. Starting pipeline..."
```

### Response codes

| Code | Meaning |
|------|---------|
| 202 | Accepted — pipeline triggered |
| 400 | Bad request — malformed payload |
| 401 | Unauthorized — HMAC/IP check failed |
| 404 | Unknown project for this ticket |
| 429 | Rate limited — ticket triggered too recently |
| 503 | Pipeline busy — max concurrent runs reached |

### `webhook register` flow

```
jiraACP webhook register --project myproject

  1. Load project config → get Jira credentials
  2. Determine public URL:
     a. Check if tunnel is running (OpenACP tunnel, ngrok, etc.)
     b. Or ask user for public URL
  3. Create Jira webhook via REST API:
     POST /rest/webhooks/1.0/webhook
     {
       "name": "jiraACP-<project>",
       "url": "<publicUrl>/webhook/jira",
       "events": ["jira:issue_updated"],
       "filters": { "issue-related-events-section": "project = <jiraProject>" }
     }
  4. Save webhook ID to config for later removal
  5. Print confirmation
```

## Security

- **HMAC verification**: Jira Cloud sends `X-Hub-Signature` with shared secret. Validate on every request.
- **IP allowlist**: Optional fallback for Jira Server (no HMAC). Atlassian publishes IP ranges for Cloud.
- **No user input in commands**: Webhook payload data is never passed to shell commands. Ticket key is validated against `^[A-Z]+-\d+$` regex before use.
- **Rate limiting**: Prevents webhook replay attacks or Jira misconfiguration from flooding pipelines.

## Edge Cases

1. **Duplicate webhook events** (Jira retries) → rate limiter deduplicates by ticket + timestamp.
2. **Ticket moved to "Ready for Dev" then back** → only triggers on forward transition, not backward.
3. **Webhook secret not configured** → all requests accepted (log warning on startup).
4. **No tunnel/public URL** → `webhook register` fails with instructions to set up tunnel.
5. **Pipeline already running for ticket** → 503 response, skip. Don't queue duplicate.
6. **Jira Server (on-premise)** → HMAC not available, use IP allowlist instead.
7. **Multiple projects matching same Jira instance** → match by Jira project key in ticket.
8. **serve not running** → webhook misses events. On next start, no replay (Jira doesn't queue).

## Test Plan

- [ ] Unit: HMAC validation accepts valid signature
- [ ] Unit: HMAC validation rejects invalid signature
- [ ] Unit: IP allowlist accepts/rejects correctly
- [ ] Unit: status transition filter matches `triggerOnStatus`
- [ ] Unit: assignee filter matches configured user
- [ ] Unit: rate limiter blocks within cooldown window
- [ ] Unit: rate limiter allows after cooldown expires
- [ ] Unit: malformed payload returns 400
- [ ] Unit: pipeline dispatched asynchronously (202 response immediate)
- [ ] Unit: `WEBHOOK_TRIGGERED` event emitted with correct data
- [ ] Unit: duplicate pipeline detection returns 503
- [ ] Integration: `webhook register` creates Jira webhook via API
- [ ] Integration: end-to-end: Jira event → webhook → pipeline run
