/**
 * finish_run: explicit end-of-heartbeat signal. It records the agent's own
 * summary and disposition for the run log; it never mutates Paperclip issue
 * state (the agent must do that through paperclip_api first).
 */
import type { ToolDefinition, ToolResult } from "./registry.js";
import { safeJsonStringify } from "../text.js";

export const FINISH_RUN_TOOL_NAME = "finish_run";

export const RUN_DISPOSITIONS = [
  "done",
  "in_review",
  "blocked",
  "in_progress",
  "todo",
  "backlog",
  "cancelled",
  "no_action",
  "failed",
] as const;

export function createFinishRunTool(): ToolDefinition {
  return {
    name: FINISH_RUN_TOOL_NAME,
    group: "control",
    description: [
      "End this heartbeat. Call it exactly once. Normally the issue comment and final status are already written via paperclip_api;",
      "in a server-verified external-chat turn (the user turn carries an \"External chat response contract\") make no paperclip_api calls and put the complete user-visible reply in summary.",
      "It records your summary in the run log and stops the loop; it does NOT change any issue. Paperclip may post the summary on the issue as this run's comment when you left none, so write it as a declarative status, not narration.",
      "disposition is the final Paperclip status you left the issue in (done, in_review, blocked, in_progress, todo, backlog, cancelled);",
      "in_progress is valid only while a live continuation path exists (active run, queued continuation, scheduled monitor): otherwise Paperclip posts \"needs a disposition\" on the issue and re-wakes you immediately, so prefer done, in_review or blocked (with owner and action).",
      "use no_action when nothing was assigned (or an approval/review wake touched no issue of your own) and failed when this run could not do useful work.",
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        disposition: {
          type: "string",
          enum: [...RUN_DISPOSITIONS],
          description: "The final Paperclip status you left the issue in (in_progress only with a live continuation path, otherwise Paperclip re-wakes you for a disposition); no_action when nothing was assigned; failed when this run could not do useful work.",
        },
        summary: {
          type: "string",
          minLength: 1,
          description: "Declarative status, 2-6 sentences: what was done, what was verified, what remains and who owns the next step. In an external-chat turn this is the full user-visible reply.",
        },
        issue_id: { type: "string", description: "Paperclip issue id you worked on, when applicable." },
        remaining_work: {
          type: "array",
          items: { type: "string" },
          description: "Outstanding items, if any.",
        },
        blocker: {
          type: "object",
          description: "When blocked: who must act and what they must do.",
          properties: {
            owner: { type: "string" },
            action: { type: "string" },
          },
          additionalProperties: false,
        },
        verification: {
          type: "array",
          items: { type: "string" },
          description: "Commands or checks you ran to verify the work (with outcome).",
        },
      },
      required: ["disposition", "summary"],
      additionalProperties: false,
    },
    handler: async (args): Promise<ToolResult> => {
      const disposition = String(args.disposition ?? "no_action");
      const summary = String(args.summary ?? "").trim();
      const details: Record<string, unknown> = {};
      if (typeof args.issue_id === "string" && args.issue_id.trim()) details.issueId = args.issue_id.trim();
      if (Array.isArray(args.remaining_work)) details.remainingWork = args.remaining_work.filter((entry) => typeof entry === "string");
      if (args.blocker && typeof args.blocker === "object") details.blocker = args.blocker;
      if (Array.isArray(args.verification)) details.verification = args.verification.filter((entry) => typeof entry === "string");
      return {
        content: safeJsonStringify({ ok: true, recorded: true, disposition, note: "Run will end now." }),
        finishRun: { disposition, summary, details },
      };
    },
  };
}
