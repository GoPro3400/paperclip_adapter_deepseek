/**
 * Thin HTTP client for the DeepSeek chat completions API.
 *
 * The API is OpenAI-compatible (https://api-docs.deepseek.com):
 * - POST {baseUrl}/chat/completions with `messages`, `tools`, `tool_choice`,
 *   `stream`, `stream_options.include_usage`, `thinking.type`,
 *   `reasoning_effort`, `max_tokens`, `temperature`, `top_p`.
 * - Assistant messages may carry `reasoning_content` (thinking mode) next to
 *   `content` and `tool_calls`.
 * - Usage reports `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` and
 *   `completion_tokens_details.reasoning_tokens`.
 * - GET {baseUrl}/models lists the model ids available to the API key.
 */
import { DEEPSEEK_BETA_PATH } from "./models.js";
import type { DeepSeekUsageSnapshot } from "./events.js";
import { errorMessage } from "./text.js";

export interface DeepSeekToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type DeepSeekMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      reasoning_content?: string;
      tool_calls?: DeepSeekToolCall[];
    }
  | { role: "tool"; tool_call_id: string; content: string };

export interface DeepSeekToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    strict?: boolean;
  };
}

export interface DeepSeekChatRequest {
  model: string;
  messages: DeepSeekMessage[];
  tools?: DeepSeekToolDefinition[];
  tool_choice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } };
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  thinking?: { type: "enabled" | "disabled" };
  reasoning_effort?: "low" | "high" | "max";
  stream?: boolean;
  stream_options?: { include_usage: boolean };
  response_format?: { type: "text" | "json_object" };
}

export interface DeepSeekChatResult {
  content: string;
  reasoningContent: string;
  toolCalls: DeepSeekToolCall[];
  finishReason: string | null;
  usage: DeepSeekUsageSnapshot;
  model: string | null;
  requestId: string | null;
  raw?: unknown;
}

export interface DeepSeekStreamCallbacks {
  onTextDelta?: (text: string) => Promise<void> | void;
  onReasoningDelta?: (text: string) => Promise<void> | void;
}

export type DeepSeekErrorKind =
  | "auth"
  | "insufficient_balance"
  | "rate_limited"
  | "invalid_request"
  | "server_error"
  | "network"
  | "timeout"
  | "cancelled";

export class DeepSeekApiError extends Error {
  readonly status: number | null;
  readonly kind: DeepSeekErrorKind;
  readonly retryable: boolean;
  readonly apiErrorType: string | null;
  readonly apiErrorCode: string | null;
  readonly retryAfterMs: number | null;

  constructor(input: {
    message: string;
    status: number | null;
    kind: DeepSeekErrorKind;
    retryable: boolean;
    apiErrorType?: string | null;
    apiErrorCode?: string | null;
    retryAfterMs?: number | null;
  }) {
    super(input.message);
    this.name = "DeepSeekApiError";
    this.status = input.status;
    this.kind = input.kind;
    this.retryable = input.retryable;
    this.apiErrorType = input.apiErrorType ?? null;
    this.apiErrorCode = input.apiErrorCode ?? null;
    this.retryAfterMs = input.retryAfterMs ?? null;
  }
}

export interface DeepSeekClientOptions {
  apiKey: string;
  baseUrl: string;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
  idleTimeoutMs?: number;
  maxRetries?: number;
  /** Base delay for exponential backoff (ms). Tests lower it. */
  retryBaseDelayMs?: number;
  userAgent?: string;
  onRetry?: (info: { attempt: number; delayMs: number; error: DeepSeekApiError }) => Promise<void> | void;
}

/** Incremental Server-Sent-Events parser: feed chunks, receive `data:` payloads. */
export class SseParser {
  private buffer = "";

  push(chunk: string): string[] {
    this.buffer += chunk;
    const events: string[] = [];
    let boundary = this.findBoundary();
    while (boundary !== null) {
      const rawEvent = this.buffer.slice(0, boundary.index);
      this.buffer = this.buffer.slice(boundary.index + boundary.length);
      const data = SseParser.extractData(rawEvent);
      if (data !== null) events.push(data);
      boundary = this.findBoundary();
    }
    return events;
  }

  flush(): string[] {
    const rest = this.buffer;
    this.buffer = "";
    const data = rest.trim() ? SseParser.extractData(rest) : null;
    return data === null ? [] : [data];
  }

  private findBoundary(): { index: number; length: number } | null {
    const lf = this.buffer.indexOf("\n\n");
    const crlf = this.buffer.indexOf("\r\n\r\n");
    if (lf === -1 && crlf === -1) return null;
    if (crlf !== -1 && (lf === -1 || crlf < lf)) return { index: crlf, length: 4 };
    return { index: lf, length: 2 };
  }

  static extractData(rawEvent: string): string | null {
    const lines = rawEvent.split(/\r?\n/);
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
    }
    if (dataLines.length === 0) return null;
    return dataLines.join("\n");
  }
}

function readNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function parseUsage(raw: unknown): DeepSeekUsageSnapshot {
  const usage = asRecord(raw) ?? {};
  const promptTokens = readNumber(usage.prompt_tokens);
  const promptDetails = asRecord(usage.prompt_tokens_details) ?? {};
  const completionDetails = asRecord(usage.completion_tokens_details) ?? {};
  const explicitHit = readNumber(usage.prompt_cache_hit_tokens) || readNumber(promptDetails.cached_tokens);
  const explicitMiss = usage.prompt_cache_miss_tokens !== undefined
    ? readNumber(usage.prompt_cache_miss_tokens)
    : Math.max(0, promptTokens - explicitHit);
  return {
    promptTokens,
    cacheHitTokens: explicitHit,
    cacheMissTokens: explicitMiss,
    completionTokens: readNumber(usage.completion_tokens),
    reasoningTokens: readNumber(completionDetails.reasoning_tokens),
  };
}

function parseRetryAfter(headers: Headers | null): number | null {
  const value = headers?.get("retry-after");
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

export function classifyHttpError(status: number, bodyText: string, headers: Headers | null): DeepSeekApiError {
  let message = bodyText.trim();
  let apiErrorType: string | null = null;
  let apiErrorCode: string | null = null;
  try {
    const parsed = JSON.parse(bodyText) as Record<string, unknown>;
    const error = asRecord(parsed.error) ?? parsed;
    if (typeof error.message === "string" && error.message.trim()) message = error.message.trim();
    if (typeof error.type === "string") apiErrorType = error.type;
    if (typeof error.code === "string") apiErrorCode = error.code;
    else if (typeof error.code === "number") apiErrorCode = String(error.code);
  } catch {
    // Non-JSON error body; keep raw text.
  }
  if (!message) message = `HTTP ${status}`;
  const withStatus = `DeepSeek API error ${status}: ${message}`;
  const retryAfterMs = parseRetryAfter(headers);
  if (status === 401 || status === 403) {
    return new DeepSeekApiError({ message: withStatus, status, kind: "auth", retryable: false, apiErrorType, apiErrorCode });
  }
  if (status === 402) {
    return new DeepSeekApiError({
      message: withStatus,
      status,
      kind: "insufficient_balance",
      retryable: false,
      apiErrorType,
      apiErrorCode,
    });
  }
  if (status === 429) {
    return new DeepSeekApiError({
      message: withStatus,
      status,
      kind: "rate_limited",
      retryable: true,
      apiErrorType,
      apiErrorCode,
      retryAfterMs,
    });
  }
  if (status === 408 || status === 409 || status >= 500) {
    return new DeepSeekApiError({
      message: withStatus,
      status,
      kind: "server_error",
      retryable: true,
      apiErrorType,
      apiErrorCode,
      retryAfterMs,
    });
  }
  return new DeepSeekApiError({ message: withStatus, status, kind: "invalid_request", retryable: false, apiErrorType, apiErrorCode });
}

interface ToolCallAccumulator {
  id: string;
  name: string;
  arguments: string;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DeepSeekApiError({ message: "Request cancelled", status: null, kind: "cancelled", retryable: false }));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DeepSeekApiError({ message: "Request cancelled", status: null, kind: "cancelled", retryable: false }));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class DeepSeekClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;
  private readonly idleTimeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly userAgent: string;
  private readonly onRetry: DeepSeekClientOptions["onRetry"];

  constructor(options: DeepSeekClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 600_000;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 180_000;
    this.maxRetries = options.maxRetries ?? 4;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 1000;
    this.userAgent = options.userAgent ?? "paperclip-adapter-deepseek";
    this.onRetry = options.onRetry;
  }

  chatCompletionsUrl(options: { beta?: boolean } = {}): string {
    const base = options.beta && !this.baseUrl.endsWith(DEEPSEEK_BETA_PATH)
      ? `${this.baseUrl}${DEEPSEEK_BETA_PATH}`
      : this.baseUrl;
    return `${base}/chat/completions`;
  }

  modelsUrl(): string {
    const base = this.baseUrl.endsWith(DEEPSEEK_BETA_PATH)
      ? this.baseUrl.slice(0, -DEEPSEEK_BETA_PATH.length)
      : this.baseUrl;
    return `${base}/models`;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      authorization: `Bearer ${this.apiKey}`,
      "content-type": "application/json",
      accept: "application/json",
      "user-agent": this.userAgent,
      ...extra,
    };
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    const response = await this.fetchWithTimeout(this.modelsUrl(), { method: "GET", headers: this.headers() }, signal);
    const text = await response.text();
    if (!response.ok) throw classifyHttpError(response.status, text, response.headers);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new DeepSeekApiError({ message: "DeepSeek /models returned invalid JSON", status: response.status, kind: "server_error", retryable: false });
    }
    const data = asRecord(parsed)?.data;
    if (!Array.isArray(data)) return [];
    return data
      .map((entry) => asRecord(entry)?.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
  }

  /**
   * Run one chat completion with retries for transient failures. Streaming is
   * used when `request.stream` is true; deltas are forwarded to the callbacks
   * while the full message is assembled for the caller.
   */
  async chat(
    request: DeepSeekChatRequest,
    options: { signal?: AbortSignal; callbacks?: DeepSeekStreamCallbacks; beta?: boolean } = {},
  ): Promise<DeepSeekChatResult> {
    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        return await this.chatOnce(request, options);
      } catch (err) {
        const error = err instanceof DeepSeekApiError
          ? err
          : new DeepSeekApiError({ message: errorMessage(err), status: null, kind: "network", retryable: true });
        if (options.signal?.aborted || error.kind === "cancelled") {
          throw new DeepSeekApiError({ message: "Request cancelled", status: null, kind: "cancelled", retryable: false });
        }
        if (!error.retryable || attempt >= this.maxRetries) throw error;
        attempt += 1;
        const backoff = Math.min(30_000, this.retryBaseDelayMs * 2 ** (attempt - 1));
        const jitter = Math.floor(Math.random() * Math.min(500, backoff / 4));
        const delayMs = Math.max(error.retryAfterMs ?? 0, backoff + jitter);
        await this.onRetry?.({ attempt, delayMs, error });
        await sleep(delayMs, options.signal);
      }
    }
  }

  private async fetchWithTimeout(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason ?? new Error("aborted"));
    if (signal?.aborted) onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error("request timeout")), this.requestTimeoutMs);
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } catch (err) {
      if (signal?.aborted) {
        throw new DeepSeekApiError({ message: "Request cancelled", status: null, kind: "cancelled", retryable: false });
      }
      if (controller.signal.aborted) {
        throw new DeepSeekApiError({ message: `DeepSeek request timed out after ${this.requestTimeoutMs}ms`, status: null, kind: "timeout", retryable: true });
      }
      throw new DeepSeekApiError({ message: `DeepSeek request failed: ${errorMessage(err)}`, status: null, kind: "network", retryable: true });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  private async chatOnce(
    request: DeepSeekChatRequest,
    options: { signal?: AbortSignal; callbacks?: DeepSeekStreamCallbacks; beta?: boolean },
  ): Promise<DeepSeekChatResult> {
    const url = this.chatCompletionsUrl({ beta: options.beta });
    const stream = request.stream === true;
    const body: DeepSeekChatRequest = stream
      ? { ...request, stream: true, stream_options: { include_usage: true } }
      : { ...request, stream: false };
    if (!stream) delete body.stream_options;

    const controller = new AbortController();
    const signal = options.signal;
    const onAbort = () => controller.abort(signal?.reason ?? new Error("aborted"));
    if (signal?.aborted) onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });

    let idleTimer: NodeJS.Timeout | null = null;
    let idleTimedOut = false;
    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idleTimedOut = true;
        controller.abort(new Error("idle timeout"));
      }, this.idleTimeoutMs);
    };
    const requestTimer = setTimeout(() => controller.abort(new Error("request timeout")), this.requestTimeoutMs);

    try {
      resetIdle();
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: "POST",
          headers: this.headers(stream ? { accept: "text/event-stream" } : {}),
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (err) {
        throw this.translateAbort(err, signal, idleTimedOut);
      }
      const requestId = response.headers.get("x-request-id") ?? response.headers.get("request-id");
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw classifyHttpError(response.status, text, response.headers);
      }
      if (!stream) {
        const text = await response.text();
        return this.parseJsonCompletion(text, requestId);
      }
      return await this.consumeStream(response, requestId, options.callbacks, resetIdle, (err) => this.translateAbort(err, signal, idleTimedOut));
    } finally {
      clearTimeout(requestTimer);
      if (idleTimer) clearTimeout(idleTimer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  private translateAbort(err: unknown, signal: AbortSignal | undefined, idleTimedOut: boolean): DeepSeekApiError {
    if (err instanceof DeepSeekApiError) return err;
    if (signal?.aborted) {
      return new DeepSeekApiError({ message: "Request cancelled", status: null, kind: "cancelled", retryable: false });
    }
    if (idleTimedOut) {
      return new DeepSeekApiError({
        message: `DeepSeek stream stalled for ${this.idleTimeoutMs}ms without data`,
        status: null,
        kind: "timeout",
        retryable: true,
      });
    }
    const message = errorMessage(err);
    if (/timeout|aborted/i.test(message)) {
      return new DeepSeekApiError({ message: `DeepSeek request timed out (${message})`, status: null, kind: "timeout", retryable: true });
    }
    return new DeepSeekApiError({ message: `DeepSeek request failed: ${message}`, status: null, kind: "network", retryable: true });
  }

  private parseJsonCompletion(text: string, requestId: string | null): DeepSeekChatResult {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new DeepSeekApiError({ message: "DeepSeek returned invalid JSON", status: null, kind: "server_error", retryable: true });
    }
    const choice = asRecord((Array.isArray(parsed.choices) ? parsed.choices[0] : null)) ?? {};
    const message = asRecord(choice.message) ?? {};
    const toolCalls: DeepSeekToolCall[] = Array.isArray(message.tool_calls)
      ? message.tool_calls
          .map((entry, index) => {
            const call = asRecord(entry);
            const fn = asRecord(call?.function);
            if (!call || !fn || typeof fn.name !== "string") return null;
            return {
              id: typeof call.id === "string" && call.id ? call.id : `call_${index}`,
              type: "function" as const,
              function: { name: fn.name, arguments: typeof fn.arguments === "string" ? fn.arguments : "{}" },
            };
          })
          .filter((entry): entry is DeepSeekToolCall => entry !== null)
      : [];
    return {
      content: typeof message.content === "string" ? message.content : "",
      reasoningContent: typeof message.reasoning_content === "string" ? message.reasoning_content : "",
      toolCalls,
      finishReason: typeof choice.finish_reason === "string" ? choice.finish_reason : null,
      usage: parseUsage(parsed.usage),
      model: typeof parsed.model === "string" ? parsed.model : null,
      requestId,
      raw: parsed,
    };
  }

  private async consumeStream(
    response: Response,
    requestId: string | null,
    callbacks: DeepSeekStreamCallbacks | undefined,
    resetIdle: () => void,
    abortError: (err: unknown) => DeepSeekApiError,
  ): Promise<DeepSeekChatResult> {
    if (!response.body) {
      throw new DeepSeekApiError({ message: "DeepSeek stream had no body", status: response.status, kind: "server_error", retryable: true });
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parser = new SseParser();
    let content = "";
    let reasoningContent = "";
    let finishReason: string | null = null;
    let usage = parseUsage(null);
    let sawUsage = false;
    let model: string | null = null;
    const toolCalls = new Map<number, ToolCallAccumulator>();
    let streamError: DeepSeekApiError | null = null;

    const handleData = async (data: string) => {
      if (data.trim() === "[DONE]") return;
      let chunk: Record<string, unknown>;
      try {
        chunk = JSON.parse(data) as Record<string, unknown>;
      } catch {
        return;
      }
      if (asRecord(chunk.error)) {
        const error = asRecord(chunk.error)!;
        streamError = new DeepSeekApiError({
          message: `DeepSeek stream error: ${typeof error.message === "string" ? error.message : JSON.stringify(error)}`,
          status: null,
          kind: "server_error",
          retryable: false,
        });
        return;
      }
      if (typeof chunk.model === "string") model = chunk.model;
      if (chunk.usage) {
        usage = parseUsage(chunk.usage);
        sawUsage = true;
      }
      const choice = asRecord(Array.isArray(chunk.choices) ? chunk.choices[0] : null);
      if (!choice) return;
      if (typeof choice.finish_reason === "string" && choice.finish_reason) finishReason = choice.finish_reason;
      const delta = asRecord(choice.delta) ?? {};
      if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
        reasoningContent += delta.reasoning_content;
        await callbacks?.onReasoningDelta?.(delta.reasoning_content);
      }
      if (typeof delta.content === "string" && delta.content) {
        content += delta.content;
        await callbacks?.onTextDelta?.(delta.content);
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const entry of delta.tool_calls) {
          const call = asRecord(entry);
          if (!call) continue;
          const index = typeof call.index === "number" ? call.index : toolCalls.size;
          const existing = toolCalls.get(index) ?? { id: "", name: "", arguments: "" };
          if (typeof call.id === "string" && call.id) existing.id = call.id;
          const fn = asRecord(call.function);
          if (fn) {
            if (typeof fn.name === "string" && fn.name) existing.name += fn.name;
            if (typeof fn.arguments === "string") existing.arguments += fn.arguments;
          }
          toolCalls.set(index, existing);
        }
      }
    };

    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        resetIdle();
        const text = decoder.decode(value, { stream: true });
        for (const data of parser.push(text)) await handleData(data);
      }
      for (const data of parser.flush()) await handleData(data);
    } catch (err) {
      throw abortError(err);
    }
    if (streamError) throw streamError;

    const orderedCalls = [...toolCalls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([index, call]) => ({
        id: call.id || `call_${index}`,
        type: "function" as const,
        function: { name: call.name, arguments: call.arguments || "{}" },
      }))
      .filter((call) => call.function.name.length > 0);

    if (!finishReason && orderedCalls.length > 0) finishReason = "tool_calls";
    if (!sawUsage) usage = parseUsage(null);
    return { content, reasoningContent, toolCalls: orderedCalls, finishReason, usage, model, requestId };
  }
}
