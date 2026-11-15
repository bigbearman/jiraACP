import type { Stage, PipelineContext, StageOutput } from "./types.js";
import { requestClarification } from "../../integrations/telegram/human-loop.js";
import { appendClarifications } from "../../memory/context-builder.js";
import path from "node:path";

const DEFAULT_QUESTIONS = ["Please clarify the ticket requirements."];

function readAnalyzeOutput(ctx: PipelineContext): {
  needsClarification: boolean;
  questions: string[];
} {
  const output = ctx.state.lastStageOutput("analyze");
  if (typeof output !== "object" || output === null) {
    return { needsClarification: false, questions: [] };
  }
  return {
    needsClarification:
      "needsClarification" in output && output.needsClarification === true,
    questions:
      "questions" in output && Array.isArray(output.questions)
        ? output.questions.filter((q): q is string => typeof q === "string")
        : [],
  };
}

export const clarifyStage: Stage = {
  id: "clarify",
  name: "Clarify",
  model: "haiku",

  async shouldSkip(ctx: PipelineContext): Promise<boolean> {
    if (!ctx.state.current.completedStages.includes("analyze")) return true;
    return !readAnalyzeOutput(ctx).needsClarification;
  },

  async run(ctx: PipelineContext): Promise<StageOutput> {
    const { config, ticketKey, memoryDir } = ctx;
    const storeDir = path.join(config.workspace.rootDir, ".jira-acp");

    const asked = readAnalyzeOutput(ctx).questions;
    const questions = asked.length > 0 ? asked : DEFAULT_QUESTIONS;

    ctx.logger.info(
      { ticketKey, questions },
      "Requesting clarification via Telegram",
    );
    await ctx.telegram
      .updateDetail(
        `⏳ Waiting for answers to ${questions.length} question(s) via Telegram…`,
      )
      .catch(() => undefined);

    const hil = config.telegram.humanInTheLoop;
    const answers = await requestClarification(
      config.telegram.botToken,
      config.telegram.chatId,
      ticketKey,
      questions,
      storeDir,
      {
        timeoutMs: hil?.clarificationTimeoutMs ?? 3_600_000,
        onTimeout: hil?.clarificationTimeoutAction ?? "skip",
      },
    );

    appendClarifications(memoryDir, answers);
    ctx.logger.info({ ticketKey }, "Clarifications received and saved");

    return { clarified: true, answers };
  },
};
