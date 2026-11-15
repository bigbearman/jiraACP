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
  '\nIMPORTANT: Return ONLY valid JSON: {"score": <number 0.0-1.0>, "missing": [...], "questions": [...]}';

const stringList = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];

function tryParseJson(raw: string): ClarityResult | null {
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    return null;
  }
  // Agent output is untrusted: a missing or non-numeric score must not pass
  // the clarity gate, so it counts as a parse failure.
  if (typeof parsed !== "object" || parsed === null || !("score" in parsed)) {
    return null;
  }
  const { score } = parsed;
  if (typeof score !== "number" || !(score >= 0 && score <= 1)) return null;
  return {
    score,
    missing: stringList("missing" in parsed ? parsed.missing : undefined),
    questions: stringList("questions" in parsed ? parsed.questions : undefined),
  };
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
    // Two attempts share the stage budget, minus a margin so the regex and
    // default-score fallbacks still run before the stage itself times out.
    const attemptTimeoutMs = Math.max(
      1_000,
      Math.floor((config.pipeline?.stageTimeouts?.analyze ?? 120_000) / 2) -
        2_000,
    );
    const agentOpts = {
      workdir: config.workspace.rootDir,
      model: "haiku" as const,
      timeoutMs: attemptTimeoutMs,
      stallTimeoutMs: Math.min(30_000, attemptTimeoutMs),
    };

    const threshold = config.jira.clarityScoreThreshold ?? 0.7;

    // Attempts 1 and 2: parse JSON, retrying once with a stricter instruction
    let retryRaw = "";
    for (const attemptPrompt of [prompt, prompt + RETRY_SUFFIX]) {
      retryRaw = await runAgent({ ...agentOpts, prompt: attemptPrompt });
      const result = tryParseJson(retryRaw);
      if (result) {
        const needsClarification = result.score < threshold;
        ctx.logger.info(
          { ticketKey, score: result.score, threshold, needsClarification },
          "Clarity analysis done",
        );
        return { ...result, needsClarification };
      }
      ctx.logger.warn({ ticketKey }, "Clarity output is not valid JSON");
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

    try {
      await ctx.telegram.send(
        `⚠️ [${ticketKey}] Analyze stage: JSON parse fallback triggered. Using default score.`,
      );
    } catch (err) {
      // The warning is best-effort: the fallback must still apply
      ctx.logger.warn({ ticketKey, err }, "Could not send fallback warning");
    }

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
