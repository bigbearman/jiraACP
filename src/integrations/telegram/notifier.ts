import type { StageId } from "../../config/schema.js";
import { getBot } from "./bot.js";
import { getOrCreateTopic } from "./topic-manager.js";
import { getVerbosity } from "./prefs.js";

export interface TelegramNotifier {
  send(message: string): Promise<number>;
  sendError(ticketKey: string, err: unknown): Promise<void>;
  sendDone(
    ticketKey: string,
    opts: { summary: string; prNumber?: number; deployUrl?: string },
  ): Promise<void>;
  notifyStageStarted(stage: StageId): Promise<void>;
  notifyStageCompleted(stage: StageId): Promise<void>;
  notifyStageFailed(stage: StageId, error: string): Promise<void>;
  notifyStageSkipped(stage: StageId): Promise<void>;
  /** Update detail text shown under the current stage in the progress message */
  updateDetail(detail: string): Promise<void>;
}

type StageStatus = "pending" | "running" | "done" | "skipped" | "failed";

const STAGE_NAME: Record<StageId, string> = {
  fetch: "Fetch Ticket",
  analyze: "Analyze",
  clarify: "Clarify",
  code: "Code",
  git: "Git / PR",
  review: "Review",
  deploy: "Deploy",
  test: "Test",
  notify: "Notify",
};

const STAGE_IDS: StageId[] = [
  "fetch",
  "analyze",
  "clarify",
  "code",
  "git",
  "review",
  "deploy",
  "test",
  "notify",
];

const STAGE_EMOJI: Record<StageId, string> = {
  fetch: "📥",
  analyze: "🔍",
  clarify: "💬",
  code: "💻",
  git: "🔀",
  review: "🔎",
  deploy: "🚀",
  test: "🧪",
  notify: "📢",
};

const STATUS_ICON: Record<StageStatus, string> = {
  pending: "⬜",
  running: "▶️",
  done: "✅",
  skipped: "⏭",
  failed: "❌",
};

export function createTelegramNotifier(
  token: string,
  chatId: number | string,
  ticketKey: string,
  projectName: string,
  fallbackTopicId?: number,
): TelegramNotifier {
  const bot = getBot(token);

  // Stage progress state
  const stageStatus: Record<string, StageStatus> = Object.fromEntries(
    STAGE_IDS.map((id) => [id, "pending" as StageStatus]),
  );
  let progressMsgId: number | undefined;
  let currentDetail: string | undefined;
  let stageStartedAt: number | undefined;
  let heartbeatTimer: NodeJS.Timeout | undefined;

  function startHeartbeat(): void {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
      upsertProgress().catch(() => undefined);
    }, 30_000);
  }

  function stopHeartbeat(): void {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
    }
  }

  // Lazy topic resolution — try forum topic, fall back to configured topicId
  let _topicResolved = false;
  let _topicId: number | undefined = fallbackTopicId;

  async function resolveTopicId(): Promise<number | undefined> {
    if (_topicResolved) return _topicId;
    _topicResolved = true;
    const created = await getOrCreateTopic(
      bot,
      chatId,
      ticketKey,
      projectName,
    ).catch(() => undefined);
    if (created !== undefined) _topicId = created;
    return _topicId;
  }

  async function makeThreadOpts(): Promise<
    Record<string, number> | Record<string, never>
  > {
    const topicId = await resolveTopicId();
    return topicId ? { message_thread_id: topicId } : {};
  }

  function buildProgressText(): string {
    const pills = STAGE_IDS.map((id) => {
      const emoji = STAGE_EMOJI[id];
      const icon = STATUS_ICON[stageStatus[id] ?? "pending"];
      return `${emoji}${icon}`;
    }).join(" ");

    const current = STAGE_IDS.find((id) => stageStatus[id] === "running");

    let statusLine = "";
    if (current) {
      const name = STAGE_NAME[current];
      let elapsed = "";
      if (stageStartedAt) {
        const secs = Math.floor((Date.now() - stageStartedAt) / 1000);
        const m = Math.floor(secs / 60);
        const s = secs % 60;
        elapsed = m > 0 ? ` (${m}m${s}s)` : ` (${s}s)`;
      }
      statusLine = `\n⏳ <b>${name}</b>${elapsed}`;
      if (currentDetail) statusLine += `\n💬 ${currentDetail}`;
    }

    return `🔄 <b>${ticketKey}</b>\n${pills}${statusLine}`;
  }

  async function upsertProgress(): Promise<void> {
    const verbosity = getVerbosity(chatId);
    if (verbosity === "low") return;

    const text = buildProgressText();
    const threadOpts = await makeThreadOpts();

    if (progressMsgId !== undefined) {
      try {
        await bot.api.editMessageText(chatId, progressMsgId, text, {
          parse_mode: "HTML",
        });
        return;
      } catch {
        // Message deleted or too old — fall through to send new
      }
    }

    const msg = await bot.api.sendMessage(chatId, text, {
      parse_mode: "HTML",
      ...threadOpts,
    });
    progressMsgId = msg.message_id;
  }

  return {
    async send(message) {
      const threadOpts = await makeThreadOpts();
      const msg = await bot.api.sendMessage(chatId, message, {
        parse_mode: "HTML",
        ...threadOpts,
      });
      return msg.message_id;
    },

    async sendError(tk, err) {
      const text = err instanceof Error ? err.message : String(err);
      const threadOpts = await makeThreadOpts();
      await bot.api.sendMessage(
        chatId,
        `❌ <b>${tk}</b> pipeline failed\n<code>${text}</code>`,
        { parse_mode: "HTML", ...threadOpts },
      );
    },

    async sendDone(tk, { summary, prNumber, deployUrl }) {
      const lines = [`✅ <b>${tk}</b> completed`, summary];
      if (prNumber) lines.push(`PR: #${prNumber}`);
      if (deployUrl) lines.push(`Deploy: ${deployUrl}`);
      const threadOpts = await makeThreadOpts();
      await bot.api.sendMessage(chatId, lines.join("\n"), {
        parse_mode: "HTML",
        ...threadOpts,
      });
    },

    async notifyStageStarted(stage) {
      stageStatus[stage] = "running";
      stageStartedAt = Date.now();
      currentDetail = undefined;
      await upsertProgress();
      startHeartbeat();
    },

    async notifyStageCompleted(stage) {
      stopHeartbeat();
      stageStatus[stage] = "done";
      currentDetail = undefined;
      await upsertProgress();
    },

    async notifyStageFailed(stage, error) {
      stopHeartbeat();
      stageStatus[stage] = "failed";
      await upsertProgress().catch(() => undefined);

      const verbosity = getVerbosity(chatId);
      if (verbosity !== "low") {
        const threadOpts = await makeThreadOpts();
        await bot.api.sendMessage(
          chatId,
          `❌ Stage <b>${stage}</b> failed:\n<code>${error.slice(0, 300)}</code>`,
          { parse_mode: "HTML", ...threadOpts },
        );
      }
    },

    async notifyStageSkipped(stage) {
      stopHeartbeat();
      stageStatus[stage] = "skipped";
      await upsertProgress();
    },

    async updateDetail(detail) {
      currentDetail = detail;
      await upsertProgress();
    },
  };
}
