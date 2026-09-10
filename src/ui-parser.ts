/**
 * Self-contained UI parser for the deepseek_api adapter (Paperclip UI parser
 * contract 1.x). It converts the JSONL run log (deepseek.* events) into
 * transcript entries for the run viewer.
 *
 * Constraints: zero runtime imports, no Node/DOM APIs, no side effects,
 * deterministic, never throws.
 */

type TranscriptEntry =
  | { kind: "assistant"; ts: string; text: string; delta?: boolean }
  | { kind: "thinking"; ts: string; text: string; delta?: boolean }
  | { kind: "user"; ts: string; text: string }
  | { kind: "tool_call"; ts: string; name: string; input: unknown; toolUseId?: string }
  | { kind: "tool_result"; ts: string; toolUseId: string; toolName?: string; content: string; isError: boolean }
  | { kind: "init"; ts: string; model: string; sessionId: string }
  | {
      kind: "result";
      ts: string;
      text: string;
      inputTokens: number;
      outputTokens: number;
      cachedTokens: number;
      costUsd: number;
      subtype: string;
      isError: boolean;
      errors: string[];
    }
  | { kind: "stderr"; ts: string; text: string }
  | { kind: "system"; ts: string; text: string }
  | { kind: "stdout"; ts: string; text: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function safeParse(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    return asRecord(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

function formatUsage(usage: Record<string, unknown> | null): string {
  if (!usage) return "";
  const parts: string[] = [];
  const hit = asNumber(usage.cacheHitTokens);
  const miss = asNumber(usage.cacheMissTokens);
  const completion = asNumber(usage.completionTokens);
  const reasoning = asNumber(usage.reasoningTokens);
  parts.push(`in ${miss + hit}${hit > 0 ? ` (${hit} cached)` : ""}`);
  parts.push(`out ${completion}${reasoning > 0 ? ` (${reasoning} reasoning)` : ""}`);
  return parts.join(", ");
}

function parseEvent(event: Record<string, unknown>, ts: string, line: string): TranscriptEntry[] {
  const type = asString(event.type);
  switch (type) {
    case "deepseek.init": {
      const model = asString(event.model, "deepseek");
      const effort = asString(event.reasoningEffort);
      const resumed = event.resumed === true;
      return [
        {
          kind: "init",
          ts,
          model: effort ? `${model} (effort: ${effort})` : model,
          sessionId: asString(event.sessionId),
        },
        {
          kind: "system",
          ts,
          text: `${resumed ? "Resumed" : "Started"} DeepSeek session${resumed ? ` with ${asNumber(event.historyMessages)} stored messages` : ""}; tools: ${Array.isArray(event.toolNames) ? event.toolNames.join(", ") : "n/a"}`,
        },
      ];
    }
    case "deepseek.status":
      return [{ kind: "system", ts, text: asString(event.message, "status") }];
    case "deepseek.warning":
      return [{ kind: "system", ts, text: `warning: ${asString(event.message, "")}` }];
    case "deepseek.error":
      return [{ kind: "stderr", ts, text: asString(event.message, "DeepSeek error") }];
    case "deepseek.thinking_delta": {
      const text = asString(event.text);
      return text ? [{ kind: "thinking", ts, text, delta: true }] : [];
    }
    case "deepseek.text_delta": {
      const text = asString(event.text);
      return text ? [{ kind: "assistant", ts, text, delta: true }] : [];
    }
    case "deepseek.thinking": {
      const text = asString(event.text);
      return text ? [{ kind: "thinking", ts, text }] : [];
    }
    case "deepseek.assistant": {
      const text = asString(event.text);
      return text ? [{ kind: "assistant", ts, text }] : [];
    }
    case "deepseek.user": {
      const text = asString(event.text);
      return text ? [{ kind: "user", ts, text }] : [];
    }
    case "deepseek.tool_call":
      return [
        {
          kind: "tool_call",
          ts,
          name: asString(event.name, "tool"),
          toolUseId: asString(event.toolCallId) || undefined,
          input: event.input ?? {},
        },
      ];
    case "deepseek.tool_result":
      return [
        {
          kind: "tool_result",
          ts,
          toolUseId: asString(event.toolCallId) || asString(event.name, "tool"),
          toolName: asString(event.name) || undefined,
          content: asString(event.output),
          isError: event.isError === true,
        },
      ];
    case "deepseek.turn": {
      const usage = asRecord(event.usage);
      const cost = typeof event.costUsd === "number" ? ` · $${event.costUsd.toFixed(4)}` : "";
      const calls = asNumber(event.toolCalls);
      return [
        {
          kind: "system",
          ts,
          text: `turn ${asNumber(event.turn)}: ${asString(event.finishReason, "?")}${calls > 0 ? ` · ${calls} tool call${calls === 1 ? "" : "s"}` : ""} · ${formatUsage(usage)}${cost}`,
        },
      ];
    }
    case "deepseek.result": {
      const usage = asRecord(event.usage);
      const status = asString(event.status, "completed");
      const disposition = asString(event.disposition);
      const errors = Array.isArray(event.errors) ? event.errors.filter((entry): entry is string => typeof entry === "string") : [];
      return [
        {
          kind: "result",
          ts,
          text: asString(event.summary) || (disposition ? `disposition: ${disposition}` : status),
          inputTokens: usage ? asNumber(usage.cacheMissTokens) : 0,
          outputTokens: usage ? asNumber(usage.completionTokens) : 0,
          cachedTokens: usage ? asNumber(usage.cacheHitTokens) : 0,
          costUsd: asNumber(event.costUsd),
          subtype: `${status}${disposition ? `:${disposition}` : ""}:${asString(event.stopReason, "unknown")}`,
          isError: status !== "completed",
          errors,
        },
      ];
    }
    default:
      if (type.startsWith("deepseek.")) return [{ kind: "system", ts, text: type }];
      return [{ kind: "stdout", ts, text: line }];
  }
}

export function parseStdoutLine(line: string, ts: string): TranscriptEntry[] {
  try {
    const trimmed = line.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith("[paperclip]")) return [{ kind: "system", ts, text: trimmed.slice("[paperclip]".length).trim() }];
    const event = safeParse(trimmed);
    if (!event) return [{ kind: "stdout", ts, text: line }];
    return parseEvent(event, ts, line);
  } catch {
    return [{ kind: "stdout", ts, text: line }];
  }
}

export function createStdoutParser(): { parseLine(line: string, ts: string): TranscriptEntry[]; reset(): void } {
  return {
    parseLine(line: string, ts: string): TranscriptEntry[] {
      return parseStdoutLine(line, ts);
    },
    reset(): void {
      // stateless
    },
  };
}
