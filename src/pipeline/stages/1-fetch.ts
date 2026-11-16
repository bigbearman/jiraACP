import type { Stage, PipelineContext, StageOutput } from "./types.js";
import { writeTicketContext } from "../../memory/context-builder.js";
import { escapeHtml } from "../../utils/html.js";

export const fetchStage: Stage = {
  id: "fetch",
  name: "Fetch Ticket",

  async run(ctx: PipelineContext): Promise<StageOutput> {
    const { config, ticketKey, memoryDir, jira } = ctx;

    ctx.logger.info({ ticketKey }, "Fetching ticket from Jira");
    await ctx.telegram
      .updateDetail(`Fetching ${ticketKey} from Jira…`)
      .catch(() => undefined);

    const { data } = await jira.get(`/issue/${ticketKey}`, {
      params: {
        fields: [
          "summary",
          "status",
          "assignee",
          "priority",
          "description",
          config.jira.acceptanceCriteriaField,
        ].join(","),
      },
    });

    const fields = data.fields as Record<string, unknown>;

    function extractText(node: unknown): string {
      if (!node) return "";
      if (typeof node === "string") return node;
      const n = node as { type?: string; text?: string; content?: unknown[] };
      if (n.type === "text") return n.text ?? "";
      if (n.content) return n.content.map(extractText).join("\n");
      return "";
    }

    const summary = (fields["summary"] as string) ?? "";
    const status =
      (fields["status"] as { name: string } | null)?.name ?? "Unknown";
    const assignee =
      (fields["assignee"] as { displayName: string } | null)?.displayName ??
      "Unassigned";
    const priority =
      (fields["priority"] as { name: string } | null)?.name ?? "Medium";
    const description = extractText(fields["description"]);
    const acceptanceCriteria = extractText(
      fields[config.jira.acceptanceCriteriaField],
    );

    writeTicketContext(memoryDir, {
      key: ticketKey,
      summary,
      description,
      acceptanceCriteria,
      priority,
    });

    ctx.logger.info({ ticketKey, summary }, "Ticket fetched");
    await ctx.telegram
      .updateDetail(`📋 ${escapeHtml(summary.slice(0, 80))}`)
      .catch(() => undefined);

    return { summary, description, acceptanceCriteria, status, assignee };
  },
};
