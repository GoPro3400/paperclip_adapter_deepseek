/**
 * The agentic loop: send the conversation to DeepSeek, execute the tool calls
 * it returns, feed the results back, and repeat until the model finishes.
 *
 * DeepSeek specifics handled here:
 * - thinking mode via `thinking.type` + `reasoning_effort` (low | high | max)
 * - `reasoning_content` is stored on assistant messages and sent back on the
 *   following requests (DeepSeek requires it inside tool-calling rounds);
 *   if the API rejects the history shape, the loop retries with a narrower
 *   policy instead of failing the heartbeat
 * - usage accounting from prompt_cache_hit/miss tokens per turn
 * - context compaction (summarize old turns) when the prompt grows too large
 */
import type { DeepSeekReasoningEffort } from "./models.js";
import {
  DeepSeekApiError,
  type DeepSeekChatRequest,
  type DeepSeekChatResult,
  type DeepSeekClient,
  type DeepSeekMessage,
  type DeepSeekToolCall,
} from "./deepseek-client.js";
import { addUsage, emptyUsage, type DeepSeekUsageSnapshot, type EventSink } from "./events.js";
import type { DeepSeekModelPricing } from "./models.js";
import { computeCostUsd } from "./pricing.js";
import { estimateTokens, safeJsonStringify, truncateMiddle } from "./text.js";
import type { ToolRegistry, ToolRuntime } from "./tools/registry.js";

export type ReasoningPolicy = "full" | "current_round" | "none";

export interface AgentLoopInput {
  client: DeepSeekClient;
  model: string;
  reasoningEffort: DeepSeekReasoningEffort;
  maxTokens: number | null;
  temperature: number | null;
  topP: number | null;
  stream: boolean;
  strictTools: boolean;
  systemPrompt: string;
  history: DeepSeekMessage[];
  userPrompt: string;
  tools: ToolRegistry;
  toolRuntime: ToolRuntime;
  maxTurns: number;
  emit: EventSink;
  signal?: AbortSignal;
  /** Epoch millis after which the loop stops with a timeout. */
  deadlineAt: number | null;
  compaction: {
    thresholdTokens: number;
    keepRecentMessages: number;
    initialPromptTokens: number;
  };
  pricing: DeepSeekModelPricing | null;
  /** Max identical failing tool calls in a row before the loop intervenes. */
  maxRepeatedFailures?: number;
  /** Reasoning policy that worked on the previous heartbeat (persisted in the session file). */
  initialReasoningPolicy?: ReasoningPolicy | null;
}

export interface FinishReport {
  disposition: string;
  summary: string;
  details: Record<string, unknown>;
}

export type AgentLoopStopReason =
  | "finish_run"
  | "final_response"
  | "max_turns"
  | "timeout"
  | "cancelled"
  | "error";

export interface AgentLoopResult {
  messages: DeepSeekMessage[];
  finalText: string;
  finish: FinishReport | null;
  usage: DeepSeekUsageSnapshot;
  costUsd: number | null;
  turns: number;
  toolCalls: number;
  toolErrors: number;
  stopReason: AgentLoopStopReason;
  error: { message: string; kind: string | null; status: number | null } | null;
  lastPromptTokens: number;
  compactions: number;
  /** Tokens spent on compaction summariser requests (included in `usage`). */
  compactionUsage: DeepSeekUsageSnapshot;
  reasoningPolicy: ReasoningPolicy;
  finishReasons: string[];
}

export const COMPACTION_SUMMARY_PREFIX = "[Context summary — earlier conversation was compacted to save context]";

export function isCompactionSummaryMessage(message: DeepSeekMessage | undefined): boolean {
  return message?.role === "user" && message.content.startsWith(COMPACTION_SUMMARY_PREFIX);
}

const WRAP_UP_PROMPT =
  "Turn limit for this heartbeat reached. Do not call any more tools. Reply with a concise status report: what was completed, what was verified, what remains, the current Paperclip issue state, and the exact next action for the following heartbeat.";

const EMPTY_RESPONSE_NUDGE =
  "Your previous reply was empty. Continue the work with a tool call, or call finish_run with the truthful disposition.";

export function thinkingRequestFields(effort: DeepSeekReasoningEffort): Pick<DeepSeekChatRequest, "thinking" | "reasoning_effort"> {
  if (effort === "none") return { thinking: { type: "disabled" } };
  return { thinking: { type: "enabled" }, reasoning_effort: effort };
}

function findLastUserIndex(messages: DeepSeekMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]!.role === "user") return index;
  }
  return -1;
}

/**
 * Shape assistant messages for the API according to the reasoning policy.
 * DeepSeek keeps `reasoning_content` on tool-calling turns; a placeholder is
 * used when a stored assistant turn has none (for example after compaction)
 * so the request passes validation in thinking mode.
 */
export function prepareMessagesForRequest(
  messages: DeepSeekMessage[],
  policy: ReasoningPolicy,
  thinkingEnabled: boolean,
): DeepSeekMessage[] {
  const lastUserIndex = findLastUserIndex(messages);
  return messages.map((message, index) => {
    if (message.role !== "assistant") return message;
    const { reasoning_content: reasoning, ...rest } = message;
    const effectivePolicy = thinkingEnabled ? policy : "none";
    if (effectivePolicy === "none") return rest;
    if (effectivePolicy === "current_round" && index < lastUserIndex) return rest;
    const value = typeof reasoning === "string" && reasoning.length > 0 ? reasoning : " ";
    return { ...rest, reasoning_content: value };
  });
}

function isReasoningShapeError(error: DeepSeekApiError): boolean {
  return error.kind === "invalid_request" && /reasoning_content/i.test(error.message);
}

function nextPolicy(policy: ReasoningPolicy): ReasoningPolicy | null {
  if (policy === "full") return "current_round";
  if (policy === "current_round") return "none";
  return null;
}

export function serializeMessagesForSummary(messages: DeepSeekMessage[], maxChars: number): string {
  const parts: string[] = [];
  for (const message of messages) {
    if (message.role === "user") parts.push(`USER:\n${truncateMiddle(message.content, 6000).text}`);
    else if (message.role === "assistant") {
      const calls = (message.tool_calls ?? [])
        .map((call) => `  - ${call.function.name}(${truncateMiddle(call.function.arguments, 1200).text})`)
        .join("\n");
      parts.push(`ASSISTANT:\n${truncateMiddle(message.content ?? "", 4000).text}${calls ? `\n  tool calls:\n${calls}` : ""}`);
    } else if (message.role === "tool") {
      parts.push(`TOOL RESULT (${message.tool_call_id}):\n${truncateMiddle(message.content, 1500).text}`);
    }
  }
  return truncateMiddle(parts.join("\n\n"), maxChars).text;
}

/**
 * Index at which the conversation is split into "older" (summarised) and
 * "recent" (kept verbatim) messages.
 *
 * A user boundary is preferred when it keeps at most twice `keepRecent`
 * messages verbatim, so a heartbeat prompt stays together with its turns when
 * that is cheap. Otherwise the cut lands on a round boundary: the walk only
 * skips backwards over tool results so an assistant `tool_calls` message is
 * never separated from its results. This is what bounds the context of a
 * single long heartbeat, whose conversation has just one user message.
 *
 * The smallest useful cut is returned as 0 when the only thing that could be
 * summarised is a previous compaction summary (and its acknowledgement).
 */
export function chooseCompactionCut(messages: DeepSeekMessage[], keepRecent: number): number {
  const initial = Math.max(0, messages.length - Math.max(1, keepRecent));
  const minimumUseful = isCompactionSummaryMessage(messages[0]) ? 2 : 1;
  let userCut = initial;
  while (userCut > 0 && messages[userCut]!.role !== "user") userCut -= 1;
  if (userCut > minimumUseful && messages.length - userCut <= keepRecent * 2) return userCut;
  let roundCut = initial;
  while (roundCut > 0 && messages[roundCut]!.role === "tool") roundCut -= 1;
  return roundCut > minimumUseful ? roundCut : 0;
}

export function toolCallInputForLog(call: DeepSeekToolCall): unknown {
  try {
    return JSON.parse(call.function.arguments);
  } catch {
    return { raw_arguments: call.function.arguments };
  }
}

export async function runAgentLoop(input: AgentLoopInput): Promise<AgentLoopResult> {
  const thinkingEnabled = input.reasoningEffort !== "none";
  const messages: DeepSeekMessage[] = [...input.history, { role: "user", content: input.userPrompt }];
  await input.emit({ type: "deepseek.user", text: input.userPrompt });
  let usage = emptyUsage();
  let turns = 0;
  let toolCalls = 0;
  let toolErrors = 0;
  let compactions = 0;
  let finish: FinishReport | null = null;
  let finalText = "";
  let policy: ReasoningPolicy = thinkingEnabled ? input.initialReasoningPolicy ?? "full" : "none";
  let lastPromptTokens = input.compaction.initialPromptTokens;
  let compactionUsage = emptyUsage();
  let compactionDisabledReason: string | null = null;
  let compactionCutWarned = false;
  let emptyNudges = 0;
  const finishReasons: string[] = [];
  const maxRepeatedFailures = input.maxRepeatedFailures ?? 4;
  let lastFailureSignature: string | null = null;
  let repeatedFailures = 0;

  const abortReason = (): AgentLoopStopReason | null => {
    if (input.signal?.aborted) {
      const reason = input.signal.reason;
      return reason instanceof Error && /timeout/i.test(reason.message) ? "timeout" : "cancelled";
    }
    if (input.deadlineAt !== null && Date.now() >= input.deadlineAt) return "timeout";
    return null;
  };

  const buildResult = (
    stopReason: AgentLoopStopReason,
    error: AgentLoopResult["error"] = null,
  ): AgentLoopResult => ({
    messages,
    finalText,
    finish,
    usage,
    costUsd: computeCostUsd(usage, input.pricing),
    turns,
    toolCalls,
    toolErrors,
    stopReason,
    error,
    lastPromptTokens,
    compactions,
    compactionUsage,
    reasoningPolicy: policy,
    finishReasons,
  });

  const summarize = async (older: DeepSeekMessage[]): Promise<string> => {
    const transcript = serializeMessagesForSummary(older, 600_000);
    const result = await input.client.chat(
      {
        model: input.model,
        messages: [
          {
            role: "system",
            content:
              "You compress an AI agent's working transcript so the agent can continue later. Write a dense, factual summary (up to ~1500 words) covering: the task/issue ids and their current Paperclip status; decisions and their reasons; files created or modified (paths) and what changed; commands run with their key results; errors encountered and how they were resolved; Paperclip actions already taken (checkouts, comments, status updates, subtasks); open questions and the next planned steps. Never invent details.",
          },
          { role: "user", content: `Transcript to compress:\n\n${transcript}` },
        ],
        thinking: { type: "disabled" },
        max_tokens: 4000,
        stream: false,
      },
      { signal: input.signal, deadlineAt: input.deadlineAt },
    );
    usage = addUsage(usage, result.usage);
    compactionUsage = addUsage(compactionUsage, result.usage);
    const cost = computeCostUsd(result.usage, input.pricing);
    await input.emit({
      type: "deepseek.status",
      message: `Compaction summariser used ${result.usage.promptTokens} prompt and ${result.usage.completionTokens} completion tokens${cost !== null ? ` ($${cost.toFixed(6)})` : ""}; counted in this run's usage.`,
    });
    return result.content.trim();
  };

  const disableCompaction = async (reason: string): Promise<void> => {
    compactionDisabledReason = reason;
    await input.emit({
      type: "deepseek.warning",
      message: `Context compaction disabled for the rest of this run, continuing with the full history: ${reason}`,
    });
  };

  const maybeCompact = async (): Promise<void> => {
    if (input.compaction.thresholdTokens <= 0) return;
    if (lastPromptTokens < input.compaction.thresholdTokens) return;
    if (compactionDisabledReason !== null) return;
    const cut = chooseCompactionCut(messages, input.compaction.keepRecentMessages);
    if (cut <= 0) {
      if (!compactionCutWarned) {
        compactionCutWarned = true;
        await input.emit({
          type: "deepseek.warning",
          message: `Context compaction is due (~${lastPromptTokens} prompt tokens) but the conversation has no earlier messages to summarize; the prompt keeps growing.`,
        });
      }
      return;
    }
    const older = messages.slice(0, cut);
    const recent = messages.slice(cut);
    await input.emit({
      type: "deepseek.status",
      message: `Compacting context: summarizing ${older.length} earlier messages (~${lastPromptTokens} prompt tokens).`,
    });
    let summary: string;
    try {
      summary = await summarize(older);
    } catch (err) {
      // Cancellation and deadlines are handled by the main loop; do not report
      // them as a compaction failure.
      if ((err instanceof DeepSeekApiError && err.kind === "cancelled") || abortReason()) throw err;
      await disableCompaction(`summariser request failed (${err instanceof Error ? err.message : String(err)})`);
      return;
    }
    if (!summary) {
      await disableCompaction("summariser returned an empty summary");
      return;
    }
    // A round boundary cut leaves an assistant message first in `recent`; the
    // acknowledgement is folded into the summary so the request never carries
    // two consecutive assistant turns.
    const recentStartsWithUser = recent[0]?.role === "user";
    messages.splice(
      0,
      messages.length,
      {
        role: "user",
        content: `${COMPACTION_SUMMARY_PREFIX}\n\n${summary}${recentStartsWithUser ? "" : "\n\nContinue from this summary; re-verify anything uncertain."}`,
      },
      ...(recentStartsWithUser
        ? [{ role: "assistant", content: "Understood. I will continue from this summary and re-verify anything uncertain.", reasoning_content: "" } as DeepSeekMessage]
        : []),
      ...recent,
    );
    compactions += 1;
    lastPromptTokens = estimateTokens(input.systemPrompt) + estimateTokens(safeJsonStringify(messages));
  };

  const callModel = async (extra: Partial<DeepSeekChatRequest> = {}): Promise<DeepSeekChatResult> => {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const request: DeepSeekChatRequest = {
        model: input.model,
        messages: [{ role: "system", content: input.systemPrompt }, ...prepareMessagesForRequest(messages, policy, thinkingEnabled)],
        tools: input.tools.size > 0 ? input.tools.definitions() : undefined,
        tool_choice: input.tools.size > 0 ? "auto" : undefined,
        ...thinkingRequestFields(input.reasoningEffort),
        ...(input.maxTokens ? { max_tokens: input.maxTokens } : {}),
        // Per the Thinking Mode page: temperature has no effect while thinking
        // is on, while top_p does take effect there (raised to a floor of 0.95)
        // and is ignored in non-thinking mode.
        ...(input.temperature !== null && !thinkingEnabled ? { temperature: input.temperature } : {}),
        ...(input.topP !== null && thinkingEnabled ? { top_p: Math.max(0.95, input.topP) } : {}),
        ...(input.topP !== null && !thinkingEnabled ? { top_p: input.topP } : {}),
        stream: input.stream,
        ...extra,
      };
      if (request.tools === undefined) delete request.tool_choice;
      try {
        return await input.client.chat(request, {
          signal: input.signal,
          beta: input.strictTools,
          deadlineAt: input.deadlineAt,
          callbacks: {
            onReasoningDelta: async (text) => {
              await input.emit({ type: "deepseek.thinking_delta", text });
            },
            onTextDelta: async (text) => {
              await input.emit({ type: "deepseek.text_delta", text });
            },
          },
        });
      } catch (err) {
        if (err instanceof DeepSeekApiError && isReasoningShapeError(err)) {
          const downgraded = nextPolicy(policy);
          if (downgraded) {
            await input.emit({
              type: "deepseek.warning",
              message: `DeepSeek rejected the reasoning_content history shape (${err.message}); retrying with policy "${downgraded}".`,
            });
            policy = downgraded;
            continue;
          }
        }
        throw err;
      }
    }
  };

  const recordTurn = async (result: DeepSeekChatResult, calls: number) => {
    turns += 1;
    usage = addUsage(usage, result.usage);
    lastPromptTokens = result.usage.promptTokens > 0
      ? result.usage.promptTokens + result.usage.completionTokens
      : estimateTokens(input.systemPrompt) + estimateTokens(safeJsonStringify(messages));
    if (result.finishReason) finishReasons.push(result.finishReason);
    // Text first, then the turn summary line, so the run log reads the same
    // way in streaming and non-streaming mode.
    if (!input.stream) {
      if (result.reasoningContent) await input.emit({ type: "deepseek.thinking", text: result.reasoningContent });
      if (result.content) await input.emit({ type: "deepseek.assistant", text: result.content });
    }
    await input.emit({
      type: "deepseek.turn",
      turn: turns,
      finishReason: result.finishReason,
      usage: result.usage,
      costUsd: computeCostUsd(result.usage, input.pricing),
      toolCalls: calls,
    });
  };

  while (turns < input.maxTurns) {
    const aborted = abortReason();
    if (aborted) return buildResult(aborted, { message: aborted === "timeout" ? "Heartbeat timed out" : "Run cancelled", kind: aborted, status: null });

    try {
      await maybeCompact();
    } catch (err) {
      const stop = abortReason() ?? ((err instanceof DeepSeekApiError && err.kind === "cancelled") ? "cancelled" : null);
      if (stop) return buildResult(stop, { message: stop === "timeout" ? "Heartbeat timed out" : "Run cancelled", kind: stop, status: null });
      throw err;
    }

    let result: DeepSeekChatResult;
    try {
      result = await callModel();
    } catch (err) {
      const stop = abortReason();
      if (stop) return buildResult(stop, { message: stop === "timeout" ? "Heartbeat timed out" : "Run cancelled", kind: stop, status: null });
      const error = err instanceof DeepSeekApiError
        ? { message: err.message, kind: err.kind, status: err.status }
        : { message: err instanceof Error ? err.message : String(err), kind: null, status: null };
      await input.emit({ type: "deepseek.error", message: error.message, ...(error.kind ? { code: error.kind } : {}) });
      return buildResult("error", error);
    }

    const assistantMessage: DeepSeekMessage = {
      role: "assistant",
      content: result.content,
      ...(thinkingEnabled ? { reasoning_content: result.reasoningContent } : {}),
      ...(result.toolCalls.length > 0 ? { tool_calls: result.toolCalls } : {}),
    };
    messages.push(assistantMessage);
    await recordTurn(result, result.toolCalls.length);

    if (result.toolCalls.length === 0) {
      if (result.finishReason === "length") {
        await input.emit({ type: "deepseek.warning", message: "Response was cut off by max_tokens; treating the partial text as final." });
      }
      if (!result.content.trim() && emptyNudges < 1 && turns < input.maxTurns) {
        emptyNudges += 1;
        messages.push({ role: "user", content: EMPTY_RESPONSE_NUDGE });
        await input.emit({ type: "deepseek.warning", message: "Model returned an empty message; nudging it to continue." });
        continue;
      }
      finalText = result.content.trim();
      return buildResult("final_response");
    }

    for (const call of result.toolCalls) {
      if (finish) {
        // finish_run ends the heartbeat: later calls in the same batch are not
        // executed, so the recorded summary cannot be contradicted by them.
        messages.push({ role: "tool", tool_call_id: call.id, content: safeJsonStringify({ ok: false, error: "Skipped: finish_run already ended the heartbeat." }) });
        continue;
      }
      const stop = abortReason();
      if (stop) {
        messages.push({ role: "tool", tool_call_id: call.id, content: safeJsonStringify({ ok: false, error: "Run was stopped before this tool call executed." }) });
        continue;
      }
      toolCalls += 1;
      await input.emit({ type: "deepseek.tool_call", toolCallId: call.id, name: call.function.name, input: toolCallInputForLog(call) });
      const startedAt = Date.now();
      const outcome = await input.tools.invoke(call.function.name, call.function.arguments, input.toolRuntime);
      const durationMs = Date.now() - startedAt;
      if (outcome.result.isError) toolErrors += 1;
      await input.emit({
        type: "deepseek.tool_result",
        toolCallId: call.id,
        name: call.function.name,
        output: outcome.result.content,
        isError: outcome.result.isError === true,
        durationMs,
      });
      messages.push({ role: "tool", tool_call_id: call.id, content: outcome.result.content });

      if (outcome.result.finishRun) {
        finish = outcome.result.finishRun;
      }

      const signature = `${call.function.name}:${call.function.arguments}`;
      if (outcome.result.isError && signature === lastFailureSignature) {
        repeatedFailures += 1;
      } else {
        repeatedFailures = outcome.result.isError ? 1 : 0;
        lastFailureSignature = outcome.result.isError ? signature : null;
      }
    }

    if (finish) {
      finalText = finish.summary;
      return buildResult("finish_run");
    }

    if (repeatedFailures >= maxRepeatedFailures) {
      repeatedFailures = 0;
      messages.push({
        role: "user",
        content: `The same tool call has failed ${maxRepeatedFailures} times in a row with the same arguments. Do not repeat it. Read the error, change the approach (different arguments, a different tool, or investigate first), or finish the run with disposition blocked/failed and explain the obstacle.`,
      });
      await input.emit({ type: "deepseek.warning", message: `Intervened after ${maxRepeatedFailures} identical failing tool calls.` });
    }
  }

  // Turn budget exhausted: ask for a wrap-up without tools.
  messages.push({ role: "user", content: WRAP_UP_PROMPT });
  await input.emit({ type: "deepseek.warning", message: `Turn limit (${input.maxTurns}) reached; requesting a wrap-up summary.` });
  try {
    const wrap = await callModel({ tool_choice: "none" });
    messages.push({
      role: "assistant",
      content: wrap.content,
      ...(thinkingEnabled ? { reasoning_content: wrap.reasoningContent } : {}),
    });
    await recordTurn(wrap, 0);
    finalText = wrap.content.trim();
  } catch (err) {
    const stop = abortReason();
    if (stop) return buildResult(stop, { message: "Run stopped during wrap-up", kind: stop, status: null });
    await input.emit({ type: "deepseek.warning", message: `Wrap-up request failed: ${err instanceof Error ? err.message : String(err)}` });
  }
  return buildResult("max_turns");
}
