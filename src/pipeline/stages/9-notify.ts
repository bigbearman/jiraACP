import type { Stage, PipelineContext, StageOutput } from "./types.js";

export const notifyStage: Stage = {
  id: "notify",
  name: "Notify",
  model: "haiku",

  async run(ctx: PipelineContext): Promise<StageOutput> {
    const { config, ticketKey, state, jira } = ctx;
    const current = state.current;

    ctx.logger.info({ ticketKey }, "Notifying: Jira + Telegram");
    await ctx.telegram
      .updateDetail("Updating Jira status and posting completion comment…")
      .catch(() => undefined);

    if (!ctx.dryRun) {
      // Find and apply "Done" transition
      const { data: transitions } = await jira.get(
        `/issue/${ticketKey}/transitions`,
      );
      const doneTransition = (
        transitions.transitions as Array<{ id: string; name: string }>
      ).find(
        (t) =>
          t.name.toLowerCase() ===
          (config.jira.doneTransition ?? "Done").toLowerCase(),
      );

      if (doneTransition) {
        await jira.post(`/issue/${ticketKey}/transitions`, {
          transition: { id: doneTransition.id },
        });
      } else {
        ctx.logger.warn(
          { ticketKey },
          `Transition "${config.jira.doneTransition}" not found — skipping`,
        );
      }

      // Add completion comment
      const prInfo = current.prNumber ? `\nPR: #${current.prNumber}` : "";
      const branchInfo = current.branchName
        ? `\nBranch: ${current.branchName}`
        : "";
      await jira.post(`/issue/${ticketKey}/comment`, {
        body: {
          type: "doc",
          version: 1,
          content: [
            {
              type: "paragraph",
              content: [
                {
                  type: "text",
                  text: `✅ Implemented via jiraACP automated pipeline.${prInfo}${branchInfo}\n\nAll stages completed: fetch → analyze → code → review → deploy → test`,
                },
              ],
            },
          ],
        },
      });

      // Reassign if configured
      if (config.jira.reassignTo) {
        await jira.put(`/issue/${ticketKey}/assignee`, {
          accountId: config.jira.reassignTo,
        });
      }

      // Telegram notification
      await ctx.telegram.sendDone(ticketKey, {
        summary: "Pipeline completed successfully",
        prNumber: current.prNumber ?? undefined,
      });
    }

    ctx.logger.info({ ticketKey }, "Notifications sent");
    return { notified: true };
  },
};
