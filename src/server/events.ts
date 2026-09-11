/**
 * JSONL run-log events. Every line the adapter writes to the run's stdout is
 * one of these objects, so the UI parser (src/ui-parser.ts) and the CLI
 * formatter can render a structured transcript. Keep the shapes in sync with
 * both consumers — they cannot import this module (the UI parser must have
 * zero runtime imports).
 */

export interface DeepSeekUsageSnapshot {
  promptTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  completionTokens: number;
  reasoningTokens: number;
}

export type DeepSeekRunEvent =
  | {
      type: "deepseek.init";
      sessionId: string;
      model: string;
      resumed: boolean;
      reasoningEffort: string;
      baseUrl: string;
      toolNames: string[];
      historyMessages: number;
    }
  | { type: "deepseek.status"; message: string }
  | { type: "deepseek.warning"; message: string }
  | { type: "deepseek.thinking_delta"; text: string }
  | { type: "deepseek.text_delta"; text: string }
  | { type: "deepseek.thinking"; text: string }
  | { type: "deepseek.assistant"; text: string }
  | { type: "deepseek.user"; text: string }
  | {
      type: "deepseek.tool_call";
      toolCallId: string;
      name: string;
      input: unknown;
    }
  | {
      type: "deepseek.tool_result";
      toolCallId: string;
      name: string;
      output: string;
      isError: boolean;
      durationMs: number;
    }
  | {
      type: "deepseek.turn";
      turn: number;
      finishReason: string | null;
      usage: DeepSeekUsageSnapshot;
      costUsd: number | null;
      toolCalls: number;
    }
  | {
      type: "deepseek.result";
      status: "completed" | "error" | "timeout" | "cancelled";
      stopReason: string;
      summary: string;
      disposition: string | null;
      turns: number;
      usage: DeepSeekUsageSnapshot;
      costUsd: number | null;
      sessionId: string;
      errors: string[];
    }
  | { type: "deepseek.error"; message: string; code?: string };

export function eventLine(event: DeepSeekRunEvent): string {
  return `${JSON.stringify(event)}\n`;
}

export function emptyUsage(): DeepSeekUsageSnapshot {
  return { promptTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0, completionTokens: 0, reasoningTokens: 0 };
}

export function addUsage(total: DeepSeekUsageSnapshot, delta: DeepSeekUsageSnapshot): DeepSeekUsageSnapshot {
  return {
    promptTokens: total.promptTokens + delta.promptTokens,
    cacheHitTokens: total.cacheHitTokens + delta.cacheHitTokens,
    cacheMissTokens: total.cacheMissTokens + delta.cacheMissTokens,
    completionTokens: total.completionTokens + delta.completionTokens,
    reasoningTokens: total.reasoningTokens + delta.reasoningTokens,
  };
}

export type EventSink = (event: DeepSeekRunEvent) => Promise<void>;
