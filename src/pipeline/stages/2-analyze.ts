import type { Stage, PipelineContext, StageOutput } from "./types.js";
import { runAgent } from "../runner.js";
import { readTicketContext } from "../../memory/context-builder.js";

interface ClarityResult {
  score: number;
  missing: string[];
  questions: string[];
}

const CLARITY_PROMPT = (ticketCtx: string, requiredFields: string[]): string =>
  `
Analyze this Jira ticket for clarity. Score from 0.0 to 1.0.

Required fields: ${requiredFields.join(", ")}

Ticket:
${ticketCtx}

Reply with JSON only:
{
  "score": 0.0-1.0,
  "missing": ["list of missing or ambiguous items"],
  "questions": ["specific questions to ask the team"]
}
`.trim();

const RETRY_SUFFIX =
  '\nIMPORTANT: Return ONLY valid JSON: {"score": 0.7, "missing": [...], "questions": [...]}';

function tryParseJson(raw: string): ClarityResult | null {
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  try {
    return JSON.parse(jsonMatch[0]) as ClarityResult;
  } catch {
    return null;
  }
}

function tryExtractScore(raw: string): number | null {
  const scoreMatch = raw.match(/"score"\s*:\s*([\d.]+)/);
  if (!scoreMatch) return null;
  const score = parseFloat(scoreMatch[1]);
  if (Number.isNaN(score) || score < 0 || score > 1) return null;
  return score;
}

export const analyzeStage: Stage = {
  id: "analyze",
  name: "Analyze Clarity",
  model: "sonnet",

  async run(ctx: PipelineContext): Promise<StageOutput> {
    const { config, memoryDir, ticketKey } = ctx;

    const ticketCtx = readTicketContext(memoryDir);
    if (!ticketCtx)
      throw new Error("ticket-context.md not found — run fetch stage first");

    ctx.logger.info({ ticketKey }, "Analyzing ticket clarity");

    const requiredFields = config.jira.requiredFields ?? [
      "description",
      "acceptanceCriteria",
    ];
    const prompt = CLARITY_PROMPT(ticketCtx, requiredFields);
    const agentOpts = {
      workdir: config.workspace.rootDir,
      model: "haiku" as const,
      timeoutMs: 60_000,
      stallTimeoutMs: 30_000,
    };

    const threshold = config.jira.clarityScoreThreshold ?? 0.7;

    // Attempt 1: parse JSON from agent output
    const raw = await runAgent({ ...agentOpts, prompt });
    const firstResult = tryParseJson(raw);

    if (firstResult) {
      const needsClarification = firstResult.score < threshold;
      ctx.logger.info(
        { ticketKey, score: firstResult.score, threshold, needsClarification },
        "Clarity analysis done",
      );
      return { ...firstResult, needsClarification };
    }

    // Attempt 2: retry agent call with stricter instruction
    ctx.logger.warn(
      { ticketKey },
      "First clarity parse failed — retrying with stricter prompt",
    );
    const retryRaw = await runAgent({
      ...agentOpts,
      prompt: prompt + RETRY_SUFFIX,
    });
    const retryResult = tryParseJson(retryRaw);

    if (retryResult) {
      const needsClarification = retryResult.score < threshold;
      ctx.logger.info(
        {
          ticketKey,
          score: retryResult.score,
          threshold,
          needsClarification,
        },
        "Clarity analysis done (retry parse)",
      );
      return { ...retryResult, needsClarification };
    }

    // Attempt 3: regex score extraction from retry output
    const extractedScore = tryExtractScore(retryRaw);
    if (extractedScore !== null) {
      ctx.logger.warn(
        { ticketKey, score: extractedScore },
        "Used regex score extraction fallback",
      );
      const needsClarification = extractedScore < threshold;
      return {
        score: extractedScore,
        missing: [],
        questions: [],
        needsClarification,
      };
    }

    // All extraction failed — emit fallback event + Telegram warning
    ctx.logger.warn(
      { ticketKey },
      "All clarity parse attempts failed — using fallback score",
    );

    ctx.state.emit({
      type: "ANALYZE_PARSE_FALLBACK",
      rawSnippet: retryRaw.slice(0, 500),
    });

    await ctx.telegram.send(
      `⚠️ [${ticketKey}] Analyze stage: JSON parse fallback triggered. Using default score.`,
    );

    const fallbackScore = config.pipeline.analyzeFallbackScore ?? 0.5;
    const needsClarification = fallbackScore < threshold;

    return {
      score: fallbackScore,
      missing: [],
      questions: [],
      needsClarification,
    };
  },
};
