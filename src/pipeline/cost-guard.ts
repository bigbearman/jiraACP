import type { TelegramNotifier } from "../integrations/telegram/notifier.js";
import { getEvents, type PipelineEvent } from "./state.js";
import { extractTokenUsage } from "./token-usage.js";

/**
 * Cost of the current run: stages completed or failed since the latest
 * STARTED event. Earlier runs of the same ticket do not count, so a resumed
 * or retried ticket gets a fresh budget.
 */
export function currentRunCostUsd(events: PipelineEvent[]): number {
  let start = 0;
  events.forEach((e, i) => {
    if (e.type === "STARTED") start = i;
  });

  let total = 0;
  for (const event of events.slice(start)) {
    if (event.type === "STAGE_COMPLETED") {
      total += extractTokenUsage(event.output)?.costUsd ?? 0;
    } else if (event.type === "STAGE_FAILED") {
      total += extractTokenUsage(event)?.costUsd ?? 0;
    }
  }
  return total;
}

export async function checkCostLimit(opts: {
  runDir: string;
  maxCostUsd: number;
  telegram: TelegramNotifier;
  ticketKey: string;
}): Promise<"continue" | "abort"> {
  const totalCost = currentRunCostUsd(getEvents(opts.runDir));

  if (totalCost >= opts.maxCostUsd) {
    await opts.telegram.send(
      `⛔ <b>${opts.ticketKey}</b> — Cost limit reached ($${totalCost.toFixed(4)} / $${opts.maxCostUsd}). Aborting pipeline.`,
    );
    return "abort";
  }

  if (totalCost >= 0.8 * opts.maxCostUsd) {
    await opts.telegram.send(
      `⚠️ <b>${opts.ticketKey}</b> — Cost at 80% of limit ($${totalCost.toFixed(4)} / $${opts.maxCostUsd}).`,
    );
  }

  return "continue";
}
