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
  "no_action",
  "failed",
] as const;

export function createFinishRunTool(): ToolDefinition {
  return {
    name: FINISH_RUN_TOOL_NAME,
    group: "control",
    description: [
      "End this heartbeat. Call it exactly once, after the issue state in Paperclip is already updated via paperclip_api",
      "(comment + status). It records your summary in the run log and stops the loop; it does NOT change any issue.",
      "Use disposition no_action when nothing was assigned, failed when the run could not do useful work.",
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        disposition: {
          type: "string",
          enum: [...RUN_DISPOSITIONS],
          description: "Final state of the work item you handled (mirrors the Paperclip status you set).",
        },
        summary: {
          type: "string",
          minLength: 1,
          description: "2-6 sentences: what was done, what was verified, what remains and who owns the next step.",
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
