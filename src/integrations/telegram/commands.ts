import fs from "node:fs";
import path from "node:path";
import axios from "axios";
import type { Context } from "grammy";
import { getBot, canControl } from "./bot.js";
import { archiveTopic } from "./topic-manager.js";
import { setVerbosity, type Verbosity } from "./prefs.js";
import { escapeHtml, splitHtmlByLines, wrapLines } from "../../utils/html.js";
import { listProjects, loadConfig, HOME_DIR } from "../../config/loader.js";
import { StateManager, getRunDir } from "../../pipeline/state.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseArgs(text: string, command: string): string[] {
  return text
    .replace(new RegExp(`^\\/${command}(?:@\\S+)?\\s*`), "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/** Find project by matching jira.projectKey prefix against ticketKey (e.g. "PROJ" in "PROJ-123") */
function findProjectForTicket(ticketKey: string): string | null {
  const prefix = ticketKey.split("-")[0]?.toUpperCase();
  if (!prefix) return null;

  const projects = listProjects();
  for (const name of projects) {
    try {
      const cfg = loadConfig(name);
      if (cfg.jira.projectKey.toUpperCase() === prefix) return name;
    } catch {
      // skip misconfigured projects
    }
  }
  return projects.length === 1 ? (projects[0] ?? null) : null;
}

function jiraClientFrom(projectName: string) {
  const cfg = loadConfig(projectName);
  return {
    client: axios.create({
      baseURL: `${cfg.jira.url}/rest/api/3`,
      headers: {
        Authorization: `Basic ${Buffer.from(`${cfg.jira.email}:${cfg.jira.token}`).toString("base64")}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
    }),
    cfg,
  };
}

async function reply(ctx: Context, text: string): Promise<void> {
  await ctx.reply(text, { parse_mode: "HTML" });
}

const errorText = (err: unknown): string =>
  escapeHtml(err instanceof Error ? err.message : String(err));

// Ticket keys end up in file paths and Jira URLs, so only the Jira shape is accepted
const TICKET_KEY = /^[A-Z][A-Z0-9_]*-\d+$/i;

const VERBOSITY_LEVELS: Verbosity[] = ["low", "medium", "high"];
const isVerbosity = (value: string | undefined): value is Verbosity =>
  VERBOSITY_LEVELS.some((level) => level === value);

interface Target {
  ticketKey: string;
  projectName: string;
}

/**
 * Validates "<ticket> [project]" arguments. Replies with the problem and
 * returns null when they are unusable.
 */
async function resolveTarget(
  ctx: Context,
  command: string,
): Promise<Target | null> {
  const [rawKey, projectArg] = parseArgs(ctx.message?.text ?? "", command);
  // Jira keys are case-insensitive; run dirs and locks are not
  const ticketKey = rawKey?.toUpperCase();

  if (!ticketKey || !TICKET_KEY.test(ticketKey)) {
    await reply(ctx, `Usage: /${command} PROJ-123 [project]`);
    return null;
  }
  if (projectArg && !listProjects().includes(projectArg)) {
    await reply(ctx, `Unknown project: ${escapeHtml(projectArg)}`);
    return null;
  }

  const projectName = projectArg ?? findProjectForTicket(ticketKey);
  if (!projectName) {
    await reply(
      ctx,
      `Cannot determine project for <b>${ticketKey}</b>. Specify: /${command} ${ticketKey} &lt;project&gt;`,
    );
    return null;
  }
  // The bot is shared by all projects: being allowed in one of them does not
  // grant control over another.
  if (!canControl(ctx, projectName)) {
    await reply(ctx, `Not allowed to control <b>${escapeHtml(projectName)}</b>.`);
    return null;
  }
  return { ticketKey, projectName };
}

// ── Command handlers ──────────────────────────────────────────────────────────

async function handleRun(ctx: Context): Promise<void> {
  const target = await resolveTarget(ctx, "run");
  if (!target) return;
  const { ticketKey, projectName } = target;

  await reply(
    ctx,
    `▶️ Starting pipeline for <b>${ticketKey}</b> (${projectName})…`,
  );

  setImmediate(async () => {
    try {
      const { runPipeline } = await import("../../pipeline/orchestrator.js");
      const config = loadConfig(projectName);
      await runPipeline(ticketKey, config);
    } catch (err) {
      // Pipeline-internal errors are sent via notifier.
      // Only catch setup errors (e.g. bad config) that escape the orchestrator.
      await reply(
        ctx,
        `❌ Pipeline failed to start: ${errorText(err)}`,
      ).catch(() => undefined);
    }
  });
}

async function handleAbort(ctx: Context): Promise<void> {
  const target = await resolveTarget(ctx, "abort");
  if (!target) return;
  const { ticketKey, projectName } = target;

  try {
    const runDir = getRunDir(projectName, ticketKey);
    if (fs.existsSync(path.join(runDir, "state.json"))) {
      const state = new StateManager(runDir).current;
      if (state.isAborted) {
        await reply(ctx, `ℹ️ <b>${ticketKey}</b> already aborted.`);
        return;
      }
      if (state.isCompleted) {
        await reply(ctx, `ℹ️ <b>${ticketKey}</b> already completed.`);
        return;
      }
    }
    const { abortPipeline } = await import("../../commands/abort.js");
    await abortPipeline(ticketKey, projectName, "Aborted via Telegram");
    await reply(ctx, `🛑 Pipeline for <b>${ticketKey}</b> aborted.`);
  } catch (err) {
    await reply(
      ctx,
      `❌ Abort failed: ${errorText(err)}`,
    );
  }
}

async function handleResume(ctx: Context): Promise<void> {
  const target = await resolveTarget(ctx, "resume");
  if (!target) return;
  const { ticketKey, projectName } = target;

  await reply(
    ctx,
    `🔁 Resuming pipeline for <b>${ticketKey}</b> (${projectName})…`,
  );

  setImmediate(async () => {
    try {
      const { resumePipeline } = await import("../../pipeline/orchestrator.js");
      const config = loadConfig(projectName);
      await resumePipeline(ticketKey, config);
    } catch {
      // errors sent via notifier
    }
  });
}

async function handleStatus(ctx: Context): Promise<void> {
  const args = parseArgs(ctx.message?.text ?? "", "status");
  const ticketKey = args[0]?.toUpperCase();
  if (ticketKey && !TICKET_KEY.test(ticketKey)) {
    await reply(ctx, "Usage: /status [PROJ-123]");
    return;
  }

  const projects = listProjects();
  if (projects.length === 0) {
    await reply(ctx, "No projects configured.");
    return;
  }

  const lines: string[] = ["<b>jiraACP status</b>\n"];

  for (const project of projects) {
    const runsDir = path.join(HOME_DIR, "runs", project);
    if (!fs.existsSync(runsDir)) continue;

    const tickets = ticketKey
      ? [ticketKey]
      : fs
          .readdirSync(runsDir)
          .filter((f) => fs.statSync(path.join(runsDir, f)).isDirectory());

    for (const key of tickets) {
      const runDir = getRunDir(project, key);
      if (!fs.existsSync(path.join(runDir, "state.json"))) continue;

      const state = new StateManager(runDir).current;

      // Show only active runs — aborted/completed are hidden unless user queries a specific ticket
      if (!ticketKey && (state.isAborted || state.isCompleted)) continue;

      const stage =
        state.currentStage ??
        (state.isCompleted ? "done" : (state.failedStage ?? "—"));

      const statusEmoji = state.isCompleted
        ? "✅"
        : state.isAborted
          ? "🛑"
          : state.pendingClarification
            ? "💬"
            : state.pendingHumanApproval
              ? "👀"
              : "🔄";

      lines.push(`${statusEmoji} <b>${key}</b> — ${stage} <i>(${project})</i>`);
    }
  }

  if (lines.length === 1) lines.push("No active runs.");
  await reply(ctx, lines.join("\n"));
}

async function handleLogs(ctx: Context): Promise<void> {
  const target = await resolveTarget(ctx, "logs");
  if (!target) return;
  const { ticketKey, projectName } = target;

  const runDir = getRunDir(projectName, ticketKey);
  const statePath = path.join(runDir, "state.json");

  if (!fs.existsSync(statePath)) {
    await reply(ctx, `No run found for <b>${ticketKey}</b>.`);
    return;
  }

  const events = fs
    .readFileSync(statePath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as {
          type: string;
          timestamp: string;
          stage?: string;
          error?: string;
          reason?: string;
        };
      } catch {
        return null;
      }
    })
    .filter((e): e is NonNullable<typeof e> => e !== null)
    .slice(-20); // last 20 events

  const lines = [`<b>Logs: ${ticketKey}</b>\n`];
  for (const e of events) {
    const time = new Date(e.timestamp).toLocaleTimeString();
    const detail = e.stage
      ? ` [${escapeHtml(e.stage)}]`
      : e.reason
        ? ` — ${escapeHtml(e.reason.slice(0, 60))}`
        : "";
    lines.push(`<code>${time}</code> ${escapeHtml(e.type)}${detail}`);
  }

  await reply(ctx, lines.join("\n"));
}

async function handleProjects(ctx: Context): Promise<void> {
  const projects = listProjects();
  if (projects.length === 0) {
    await reply(ctx, "No projects configured.\nRun: <code>jiraACP init</code>");
    return;
  }

  const lines = ["<b>Configured projects</b>\n"];
  for (const name of projects) {
    try {
      const cfg = loadConfig(name);
      lines.push(`• <b>${name}</b> — ${cfg.jira.projectKey} @ ${cfg.jira.url}`);
    } catch {
      lines.push(`• <b>${name}</b> — <i>(config error)</i>`);
    }
  }
  await reply(ctx, lines.join("\n"));
}

async function handleTickets(ctx: Context): Promise<void> {
  const args = parseArgs(ctx.message?.text ?? "", "tickets");
  const projectArg = args[0];

  const projects = listProjects();
  const projectName =
    projectArg ?? (projects.length === 1 ? projects[0] : null);

  if (
    !projectName ||
    !projects.includes(projectName) ||
    !canControl(ctx, projectName)
  ) {
    await reply(
      ctx,
      `Specify project: /tickets &lt;project&gt;\nAvailable: ${projects.join(", ")}`,
    );
    return;
  }

  await reply(ctx, `🔍 Fetching tickets for <b>${projectName}</b>…`);

  interface JiraIssue {
    key: string;
    fields: {
      summary: string;
      status: { name: string };
      priority?: { name: string };
      assignee?: { displayName: string } | null;
      fixVersions?: Array<{ name: string }>;
    };
  }

  const STATUS_ICON: Record<string, string> = {
    "In Progress": "🔄",
    "In Review": "👀",
    Done: "✅",
    "Spec Review": "📋",
  };

  try {
    const { client, cfg } = jiraClientFrom(projectName);

    const assigneeJql = cfg.jira.assignees
      .map((a) => `assignee = "${a}"`)
      .join(" OR ");

    // POST /search/jql — groups by fixVersion, same approach as jira_tickets.py
    const { data } = await client.post("/search/jql", {
      jql: `project = ${cfg.jira.projectKey} AND (${assigneeJql}) AND status != Done ORDER BY fixVersion ASC, created DESC`,
      fields: ["summary", "status", "priority", "assignee", "fixVersions"],
      maxResults: 50,
    });

    const issues = (data.issues ?? []) as JiraIssue[];
    if (issues.length === 0) {
      await reply(ctx, "No open tickets found.");
      return;
    }

    // Group by fixVersion
    const grouped = new Map<string, JiraIssue[]>();
    for (const issue of issues) {
      const version = issue.fields.fixVersions?.[0]?.name ?? "Unplanned";
      if (!grouped.has(version)) grouped.set(version, []);
      grouped.get(version)!.push(issue);
    }

    const lines: string[] = [
      `<b>${projectName}</b> — ${issues.length} open tickets\n`,
    ];
    for (const [version, vIssues] of grouped) {
      lines.push(`<b>📦 ${escapeHtml(version)}</b> (${vIssues.length})`);
      for (const issue of vIssues) {
        const status = issue.fields.status.name;
        const icon = STATUS_ICON[status] ?? "⬜";
        const prio = issue.fields.priority?.name ?? "";
        const assignee = issue.fields.assignee?.displayName ?? "Unassigned";
        lines.push(
          `${icon} <b>${escapeHtml(issue.key)}</b> ${escapeHtml(issue.fields.summary.slice(0, 55))}\n   ${escapeHtml(`${status} · ${prio} · ${assignee}`)}`,
        );
      }
      lines.push("");
    }

    await reply(ctx, lines.join("\n"));
  } catch (err) {
    await reply(
      ctx,
      `❌ Jira error: ${errorText(err)}`,
    );
  }
}

async function handleTicket(ctx: Context): Promise<void> {
  const target = await resolveTarget(ctx, "ticket");
  if (!target) return;
  const { ticketKey, projectName } = target;

  try {
    const { client, cfg } = jiraClientFrom(projectName);
    const { data } = await client.get(`/issue/${ticketKey}`, {
      params: {
        fields: [
          "summary",
          "status",
          "priority",
          "assignee",
          "description",
          "fixVersions",
          cfg.jira.acceptanceCriteriaField ?? "customfield_10016",
        ].join(","),
      },
    });

    // Parse Atlassian Document Format (ADF) → plain text preserving structure
    function adfToText(node: unknown, depth = 0): string {
      if (!node) return "";
      if (typeof node === "string") return escapeHtml(node);

      const n = node as {
        type?: string;
        text?: string;
        content?: unknown[];
        attrs?: { level?: number; order?: number };
        marks?: Array<{ type: string }>;
      };

      switch (n.type) {
        case "text": {
          let t = escapeHtml(n.text ?? "");
          if (n.marks?.some((m) => m.type === "strong")) t = wrapLines(t, "b");
          if (n.marks?.some((m) => m.type === "em")) t = wrapLines(t, "i");
          if (n.marks?.some((m) => m.type === "code")) t = wrapLines(t, "code");
          return t;
        }
        case "paragraph":
          return (
            (n.content?.map((c) => adfToText(c, depth)).join("") ?? "") + "\n"
          );
        case "heading": {
          const level = n.attrs?.level ?? 1;
          const prefix = level <= 2 ? "▸ " : "  ";
          return (
            prefix +
            (n.content?.map((c) => adfToText(c, depth)).join("") ?? "") +
            "\n"
          );
        }
        case "bulletList":
          return n.content?.map((c) => adfToText(c, depth + 1)).join("") ?? "";
        case "orderedList":
          return (
            n.content
              ?.map((c, i) =>
                adfToText(c, depth + 1).replace(
                  /^•/,
                  `${(n.attrs?.order ?? 1) + i}.`,
                ),
              )
              .join("") ?? ""
          );
        case "listItem": {
          const indent = "  ".repeat(depth - 1);
          const text =
            n.content
              ?.map((c) => adfToText(c, depth))
              .join("")
              .trimEnd() ?? "";
          return `${indent}• ${text}\n`;
        }
        case "codeBlock":
          return (
            wrapLines(
              n.content?.map((c) => adfToText(c, depth)).join("") ?? "",
              "code",
            ) + "\n"
          );
        case "blockquote":
          return (
            n.content?.map((c) => "  " + adfToText(c, depth)).join("") ?? ""
          );
        case "rule":
          return "─────\n";
        case "hardBreak":
          return "\n";
        case "doc":
        default:
          return n.content?.map((c) => adfToText(c, depth)).join("") ?? "";
      }
    }

    const description = adfToText(data.fields.description).trim();
    const ac = adfToText(
      data.fields[cfg.jira.acceptanceCriteriaField ?? "customfield_10016"],
    ).trim();

    const lines = [
      `<b>${escapeHtml(String(data.key))}</b> — ${escapeHtml(String(data.fields.summary ?? ""))}`,
      `Status: ${escapeHtml(String(data.fields.status?.name ?? "—"))}`,
      `Priority: ${escapeHtml(String(data.fields.priority?.name ?? "—"))}`,
      `Assignee: ${escapeHtml(String(data.fields.assignee?.displayName ?? "Unassigned"))}`,
    ];
    if (description) lines.push("", "<b>Description</b>", description);
    if (ac) lines.push("", "<b>Acceptance Criteria</b>", ac);

    // Telegram caps a message at 4096 chars: long tickets go out in several
    for (const chunk of splitHtmlByLines(lines.join("\n"))) {
      await reply(ctx, chunk);
    }
  } catch (err) {
    await reply(
      ctx,
      `❌ Jira error: ${errorText(err)}`,
    );
  }
}

async function handleArchive(ctx: Context): Promise<void> {
  const target = await resolveTarget(ctx, "archive");
  if (!target) return;
  const { ticketKey, projectName } = target;

  const chatId = ctx.chat?.id;
  if (!chatId) return;

  try {
    const cfg = loadConfig(projectName);
    const bot = getBot(cfg.telegram.botToken);
    await archiveTopic(bot, chatId, ticketKey, projectName);
    await reply(ctx, `🗂 Topic for <b>${ticketKey}</b> archived.`);
  } catch (err) {
    await reply(
      ctx,
      `❌ Archive failed: ${errorText(err)}`,
    );
  }
}

async function handleVerbosity(ctx: Context): Promise<void> {
  const args = parseArgs(ctx.message?.text ?? "", "verbosity");
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const level = args[0];

  if (!isVerbosity(level)) {
    await ctx.reply("Choose verbosity level:", {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "🔕 low", callback_data: `verbosity:low` },
            { text: "🔔 medium", callback_data: `verbosity:medium` },
            { text: "📣 high", callback_data: `verbosity:high` },
          ],
        ],
      },
    });
    return;
  }

  setVerbosity(chatId, level);
  await reply(ctx, `✅ Verbosity set to <b>${level}</b>.`);
}

// ── Registration ──────────────────────────────────────────────────────────────

export function registerBotCommands(token: string): void {
  const bot = getBot(token);

  bot.command("run", (ctx) => handleRun(ctx).catch(() => undefined));
  bot.command("abort", (ctx) => handleAbort(ctx).catch(() => undefined));
  bot.command("resume", (ctx) => handleResume(ctx).catch(() => undefined));
  bot.command("status", (ctx) => handleStatus(ctx).catch(() => undefined));
  bot.command("logs", (ctx) => handleLogs(ctx).catch(() => undefined));
  bot.command("projects", (ctx) => handleProjects(ctx).catch(() => undefined));
  bot.command("tickets", (ctx) => handleTickets(ctx).catch(() => undefined));
  bot.command("ticket", (ctx) => handleTicket(ctx).catch(() => undefined));
  bot.command("archive", (ctx) => handleArchive(ctx).catch(() => undefined));
  bot.command("verbosity", (ctx) =>
    handleVerbosity(ctx).catch(() => undefined),
  );

  // Inline keyboard for verbosity
  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data ?? "";
    if (!data.startsWith("verbosity:")) return;

    const level = data.slice("verbosity:".length);
    if (!isVerbosity(level)) return;
    const chatId = ctx.chat?.id;
    if (chatId) setVerbosity(chatId, level);

    await ctx.answerCallbackQuery({ text: `Verbosity set to ${level}` });
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
  });
}
