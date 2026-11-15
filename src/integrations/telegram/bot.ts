import path from "node:path";
import os from "node:os";
import { Bot, type Context } from "grammy";
import { createLogger } from "../../utils/logger.js";
import { listProjects, loadConfig } from "../../config/loader.js";

let _bot: Bot | null = null;
let _polling = false;

const STORE_DIR = path.join(os.homedir(), ".jira-acp");

export function getBot(token: string): Bot {
  if (!_bot) {
    _bot = new Bot(token);
  }
  return _bot;
}

export function resetBot(): void {
  _bot = null;
  _polling = false;
  _access = null;
}

/** Who may control one project through the bot */
export interface ProjectAccess {
  project: string;
  /** Chat the project is configured to post in */
  chatId: string;
  /** Explicit user allow-list; when non-empty it replaces the chat check */
  userIds: number[];
}

export interface Sender {
  chat: { id: number; username?: string } | undefined;
  userId: number | undefined;
}

export function isAuthorized(rule: ProjectAccess, sender: Sender): boolean {
  if (rule.userIds.length > 0) {
    return sender.userId !== undefined && rule.userIds.includes(sender.userId);
  }
  const { chat } = sender;
  if (!chat) return false;
  // Telegram usernames are case-insensitive
  return (
    rule.chatId === String(chat.id) ||
    (chat.username !== undefined &&
      rule.chatId.toLowerCase() === `@${chat.username.toLowerCase()}`)
  );
}

const ACCESS_TTL_MS = 30_000;
let _access: { rules: ProjectAccess[]; loadedAt: number } | null = null;

// Cached briefly: this runs for every message in the chat, and reading and
// validating every project config each time would block the event loop.
function loadAccessRules(): ProjectAccess[] {
  if (_access && Date.now() - _access.loadedAt < ACCESS_TTL_MS) {
    return _access.rules;
  }
  const rules: ProjectAccess[] = [];
  for (const project of listProjects()) {
    try {
      const { telegram } = loadConfig(project);
      rules.push({
        project,
        chatId: String(telegram.chatId),
        userIds: telegram.allowedUserIds,
      });
    } catch {
      // skip misconfigured projects
    }
  }
  _access = { rules, loadedAt: Date.now() };
  return rules;
}

export function senderOf(ctx: Context): Sender {
  return {
    chat: ctx.chat
      ? {
          id: ctx.chat.id,
          username: "username" in ctx.chat ? ctx.chat.username : undefined,
        }
      : undefined,
    userId: ctx.from?.id,
  };
}

/** True when the sender may control the given project (any project if omitted). */
export function canControl(ctx: Context, project?: string): boolean {
  const sender = senderOf(ctx);
  return loadAccessRules().some(
    (rule) =>
      (project === undefined || rule.project === project) &&
      isAuthorized(rule, sender),
  );
}

/**
 * One-time bot setup: registers all command handlers, pushes command menu to
 * Telegram, and starts long-polling in the background.
 * Safe to call multiple times — idempotent after first call.
 */
export async function initBot(token: string): Promise<void> {
  const logger = createLogger("telegram:bot");
  const bot = getBot(token);

  if (_polling) return;
  _polling = true;

  const { registerAnswerHandler, registerApprovalHandlers, loadPendingStore } =
    await import("./human-loop.js");
  const { registerBotCommands } = await import("./commands.js");

  // Must be registered before any handler: the bot can start pipelines,
  // merge PRs and trigger deploys, so strangers are ignored entirely.
  bot.use(async (ctx, next) => {
    if (canControl(ctx)) {
      await next();
      return;
    }
    logger.warn(
      { chatId: ctx.chat?.id, userId: ctx.from?.id },
      "Ignored Telegram update from unauthorized sender",
    );
  });

  loadPendingStore(STORE_DIR);
  registerAnswerHandler(token, STORE_DIR);
  registerApprovalHandlers(token);
  registerBotCommands(token);

  await bot.api.setMyCommands([
    // Pipeline control
    { command: "run", description: "Start pipeline: /run PROJ-123 [project]" },
    { command: "abort", description: "Abort pipeline: /abort PROJ-123" },
    { command: "resume", description: "Resume pipeline: /resume PROJ-123" },
    // Monitoring
    {
      command: "status",
      description: "Show pipeline status: /status [PROJ-123]",
    },
    { command: "logs", description: "Show recent events: /logs PROJ-123" },
    // Jira
    {
      command: "tickets",
      description: "List sprint tickets: /tickets [project]",
    },
    { command: "ticket", description: "View ticket detail: /ticket PROJ-123" },
    // Human-in-the-loop
    {
      command: "answer",
      description: "Reply to clarification: /answer PROJ-123\\n1. answer",
    },
    { command: "approve", description: "Approve PR review: /approve PROJ-123" },
    { command: "reject", description: "Reject PR review: /reject PROJ-123" },
    // Utility
    { command: "projects", description: "List configured projects" },
    { command: "archive", description: "Archive topic: /archive PROJ-123" },
    {
      command: "verbosity",
      description: "Set notification level: /verbosity low|medium|high",
    },
  ]);

  logger.info("Telegram commands registered");

  bot.start().catch((err: unknown) => {
    logger.error({ err }, "Telegram bot polling error");
  });

  logger.info("Telegram bot polling started");
}
