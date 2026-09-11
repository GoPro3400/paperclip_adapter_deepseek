import { DeepSeekApiError, type DeepSeekChatRequest, type DeepSeekChatResult, type DeepSeekToolCall } from "../deepseek-client.js";
import { emptyUsage, type DeepSeekRunEvent, type DeepSeekUsageSnapshot } from "../events.js";

export function sseResponse(chunks: unknown[], options: { status?: number; headers?: Record<string, string>; splitAt?: number[] } = {}): Response {
  const lines = chunks.map((chunk) => (typeof chunk === "string" ? `data: ${chunk}\n\n` : `data: ${JSON.stringify(chunk)}\n\n`));
  const text = `${lines.join("")}data: [DONE]\n\n`;
  const encoder = new TextEncoder();
  const pieces: string[] = [];
  if (options.splitAt && options.splitAt.length > 0) {
    let last = 0;
    for (const index of options.splitAt) {
      pieces.push(text.slice(last, index));
      last = index;
    }
    pieces.push(text.slice(last));
  } else {
    pieces.push(text);
  }
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const piece of pieces) controller.enqueue(encoder.encode(piece));
      controller.close();
    },
  });
  return new Response(stream, {
    status: options.status ?? 200,
    headers: { "content-type": "text/event-stream", ...(options.headers ?? {}) },
  });
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

export function usage(partial: Partial<DeepSeekUsageSnapshot> = {}): DeepSeekUsageSnapshot {
  return { ...emptyUsage(), ...partial };
}

export function chatResult(partial: Partial<DeepSeekChatResult> = {}): DeepSeekChatResult {
  return {
    content: "",
    reasoningContent: "",
    toolCalls: [],
    finishReason: "stop",
    usage: usage({ promptTokens: 100, cacheMissTokens: 100, completionTokens: 20 }),
    model: "deepseek-v4-flash",
    requestId: null,
    ...partial,
  };
}

export function toolCall(name: string, args: Record<string, unknown> | string, id = `call_${name}_${Math.random().toString(36).slice(2, 8)}`): DeepSeekToolCall {
  return { id, type: "function", function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) } };
}

export type ScriptedTurn = DeepSeekChatResult | ((request: DeepSeekChatRequest) => DeepSeekChatResult | Promise<DeepSeekChatResult>) | Error;

/** A stand-in for DeepSeekClient that replays scripted results and records requests. */
export class FakeClient {
  readonly requests: DeepSeekChatRequest[] = [];
  private index = 0;

  constructor(private readonly script: ScriptedTurn[]) {}

  async chat(request: DeepSeekChatRequest): Promise<DeepSeekChatResult> {
    this.requests.push(request);
    const step = this.script[this.index];
    this.index += 1;
    if (step === undefined) throw new Error(`FakeClient: no scripted result for request #${this.index}`);
    if (step instanceof Error) throw step;
    if (typeof step === "function") return step(request);
    return step;
  }
}

export function reasoningShapeError(): DeepSeekApiError {
  return new DeepSeekApiError({
    message: "DeepSeek API error 400: The reasoning_content field must be provided for assistant messages in thinking mode",
    status: 400,
    kind: "invalid_request",
    retryable: false,
  });
}

export function collectEvents(): { events: DeepSeekRunEvent[]; emit: (event: DeepSeekRunEvent) => Promise<void> } {
  const events: DeepSeekRunEvent[] = [];
  return {
    events,
    emit: async (event) => {
      events.push(event);
    },
  };
}
