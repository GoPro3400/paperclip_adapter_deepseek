import { describe, expect, it, vi } from "vitest";
import { DeepSeekApiError, DeepSeekClient, SseParser, classifyHttpError, parseUsage } from "../deepseek-client.js";
import { jsonResponse, sseResponse } from "./helpers.js";

describe("SseParser", () => {
  it("splits events across chunk boundaries and joins multi-line data", () => {
    const parser = new SseParser();
    expect(parser.push('data: {"a":1}\n\nda')).toEqual(['{"a":1}']);
    expect(parser.push('ta: {"b":2}\r\n\r\n: comment\n\ndata: x\ndata: y\n\n')).toEqual(['{"b":2}', "x\ny"]);
    expect(parser.push("data: [DONE]")).toEqual([]);
    expect(parser.flush()).toEqual(["[DONE]"]);
  });
});

describe("parseUsage / classifyHttpError", () => {
  it("reads DeepSeek cache hit/miss and reasoning tokens", () => {
    const usage = parseUsage({
      prompt_tokens: 120,
      completion_tokens: 30,
      prompt_cache_hit_tokens: 100,
      prompt_cache_miss_tokens: 20,
      completion_tokens_details: { reasoning_tokens: 12 },
    });
    expect(usage).toEqual({ promptTokens: 120, cacheHitTokens: 100, cacheMissTokens: 20, completionTokens: 30, reasoningTokens: 12 });
    const derived = parseUsage({ prompt_tokens: 50, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 10 } });
    expect(derived.cacheMissTokens).toBe(40);
    expect(derived.cacheHitTokens).toBe(10);
  });

  it("classifies HTTP statuses", () => {
    expect(classifyHttpError(401, '{"error":{"message":"bad key","type":"authentication_error"}}', null).kind).toBe("auth");
    expect(classifyHttpError(402, "Insufficient Balance", null).kind).toBe("insufficient_balance");
    const limited = classifyHttpError(429, "", new Headers({ "retry-after": "2" }));
    expect(limited.kind).toBe("rate_limited");
    expect(limited.retryable).toBe(true);
    expect(limited.retryAfterMs).toBe(2000);
    expect(classifyHttpError(503, "overloaded", null).retryable).toBe(true);
    expect(classifyHttpError(422, '{"error":{"message":"invalid model"}}', null).message).toContain("invalid model");
  });
});

describe("DeepSeekClient.chat", () => {
  it("assembles a streamed response with reasoning, text, tool calls and usage", async () => {
    const chunks = [
      { id: "1", model: "deepseek-v4-flash", choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "Let me " } }] },
      { choices: [{ index: 0, delta: { reasoning_content: "think." } }] },
      { choices: [{ index: 0, delta: { content: "Running " } }] },
      { choices: [{ index: 0, delta: { content: "tests." } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "run_shell", arguments: '{"comm' } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'and":"npm test"}' } }] } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
      { choices: [], usage: { prompt_tokens: 40, completion_tokens: 9, prompt_cache_hit_tokens: 32, prompt_cache_miss_tokens: 8, completion_tokens_details: { reasoning_tokens: 4 } } },
    ];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.stream).toBe(true);
      expect(body.stream_options).toEqual({ include_usage: true });
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer sk-test");
      return sseResponse(chunks, { splitAt: [17, 90, 250] });
    });
    const client = new DeepSeekClient({ apiKey: "sk-test", baseUrl: "https://api.deepseek.com", fetchImpl: fetchImpl as unknown as typeof fetch });
    const reasoning: string[] = [];
    const text: string[] = [];
    const result = await client.chat(
      { model: "deepseek-v4-flash", messages: [{ role: "user", content: "hi" }], stream: true },
      { callbacks: { onReasoningDelta: (t) => void reasoning.push(t), onTextDelta: (t) => void text.push(t) } },
    );
    expect(reasoning.join("")).toBe("Let me think.");
    expect(text.join("")).toBe("Running tests.");
    expect(result.content).toBe("Running tests.");
    expect(result.reasoningContent).toBe("Let me think.");
    expect(result.toolCalls).toEqual([{ id: "call_1", type: "function", function: { name: "run_shell", arguments: '{"command":"npm test"}' } }]);
    expect(result.finishReason).toBe("tool_calls");
    expect(result.usage.cacheHitTokens).toBe(32);
    expect(result.usage.reasoningTokens).toBe(4);
    expect(fetchImpl.mock.calls[0]![0]).toBe("https://api.deepseek.com/chat/completions");
  });

  it("parses non-streaming responses and uses the beta endpoint for strict tools", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toBe("https://api.deepseek.com/beta/chat/completions");
      return jsonResponse({
        model: "deepseek-v4-pro",
        choices: [{ message: { role: "assistant", content: "done", reasoning_content: "r", tool_calls: [{ id: "c1", type: "function", function: { name: "finish_run", arguments: "{}" } }] }, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 10, completion_tokens: 2 },
      });
    });
    const client = new DeepSeekClient({ apiKey: "k", baseUrl: "https://api.deepseek.com/", fetchImpl: fetchImpl as unknown as typeof fetch });
    const result = await client.chat({ model: "deepseek-v4-pro", messages: [], stream: false }, { beta: true });
    expect(result.content).toBe("done");
    expect(result.toolCalls[0]!.function.name).toBe("finish_run");
    expect(result.usage.cacheMissTokens).toBe(10);
  });

  it("retries transient failures and gives up on auth errors", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return new Response("overloaded", { status: 503 });
      if (calls === 2) throw new Error("socket hang up");
      return jsonResponse({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: {} });
    });
    const onRetry = vi.fn();
    const client = new DeepSeekClient({ apiKey: "k", baseUrl: "https://api.deepseek.com", fetchImpl: fetchImpl as unknown as typeof fetch, retryBaseDelayMs: 1, maxRetries: 3, onRetry });
    const result = await client.chat({ model: "m", messages: [], stream: false });
    expect(result.content).toBe("ok");
    expect(onRetry).toHaveBeenCalledTimes(2);

    const authFetch = vi.fn(async () => new Response('{"error":{"message":"Authentication Fails"}}', { status: 401 }));
    const authClient = new DeepSeekClient({ apiKey: "k", baseUrl: "https://api.deepseek.com", fetchImpl: authFetch as unknown as typeof fetch, retryBaseDelayMs: 1 });
    await expect(authClient.chat({ model: "m", messages: [], stream: false })).rejects.toMatchObject({ kind: "auth", retryable: false });
    expect(authFetch).toHaveBeenCalledTimes(1);
  });

  it("surfaces stream errors and lists models", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith("/models")) return jsonResponse({ object: "list", data: [{ id: "deepseek-v4-pro" }, { id: "deepseek-v4-flash" }] });
      return sseResponse([{ error: { message: "model overloaded" } }]);
    });
    const client = new DeepSeekClient({ apiKey: "k", baseUrl: "https://api.deepseek.com/beta", fetchImpl: fetchImpl as unknown as typeof fetch, retryBaseDelayMs: 1, maxRetries: 0 });
    expect(await client.listModels()).toEqual(["deepseek-v4-pro", "deepseek-v4-flash"]);
    expect(fetchImpl.mock.calls[0]![0]).toBe("https://api.deepseek.com/models");
    await expect(client.chat({ model: "m", messages: [], stream: true })).rejects.toBeInstanceOf(DeepSeekApiError);
  });

  it("honours cancellation", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn((_: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    }));
    const client = new DeepSeekClient({ apiKey: "k", baseUrl: "https://api.deepseek.com", fetchImpl: fetchImpl as unknown as typeof fetch, retryBaseDelayMs: 1 });
    const pending = client.chat({ model: "m", messages: [], stream: false }, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ kind: "cancelled" });
  });
});

describe("DeepSeekClient timeouts, retries and routing", () => {
  it("does not apply the idle timeout to non-streaming completions (DS-01)", async () => {
    const fetchImpl = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          setTimeout(() => resolve(jsonResponse({ choices: [{ message: { content: "slow but fine" }, finish_reason: "stop" }], usage: {} })), 150);
        }),
    );
    const client = new DeepSeekClient({
      apiKey: "k",
      baseUrl: "https://api.deepseek.com",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      idleTimeoutMs: 40,
      requestTimeoutMs: 5_000,
      maxRetries: 2,
      retryBaseDelayMs: 1,
    });
    const result = await client.chat({ model: "m", messages: [], stream: false });
    expect(result.content).toBe("slow but fine");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not retry the total request timeout (DS-05)", async () => {
    const fetchImpl = vi.fn(
      (_: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const onRetry = vi.fn();
    const client = new DeepSeekClient({
      apiKey: "k",
      baseUrl: "https://api.deepseek.com",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      requestTimeoutMs: 30,
      maxRetries: 3,
      retryBaseDelayMs: 1,
      onRetry,
    });
    await expect(client.chat({ model: "m", messages: [], stream: true })).rejects.toMatchObject({ kind: "timeout", retryable: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("skips retries that cannot finish before the caller's deadline (DS-05)", async () => {
    const fetchImpl = vi.fn(async () => new Response("overloaded", { status: 503 }));
    const onRetry = vi.fn();
    const client = new DeepSeekClient({ apiKey: "k", baseUrl: "https://api.deepseek.com", fetchImpl: fetchImpl as unknown as typeof fetch, retryBaseDelayMs: 1, maxRetries: 3, onRetry });
    await expect(client.chat({ model: "m", messages: [], stream: false }, { deadlineAt: Date.now() + 1_000 })).rejects.toMatchObject({ kind: "server_error", status: 503 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("reports partial output to onRetry when a stream dies after emitting deltas (PF-12)", async () => {
    let calls = 0;
    const encoder = new TextEncoder();
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        let pulls = 0;
        const stream = new ReadableStream<Uint8Array>({
          pull(controller) {
            pulls += 1;
            if (pulls === 1) controller.enqueue(encoder.encode('data: {"choices":[{"index":0,"delta":{"content":"partial "}}]}\n\n'));
            else controller.error(new Error("socket reset"));
          },
        });
        return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      return sseResponse([{ choices: [{ index: 0, delta: { content: "complete" }, finish_reason: "stop" }] }]);
    });
    const onRetry = vi.fn();
    const text: string[] = [];
    const client = new DeepSeekClient({ apiKey: "k", baseUrl: "https://api.deepseek.com", fetchImpl: fetchImpl as unknown as typeof fetch, retryBaseDelayMs: 1, maxRetries: 2, onRetry });
    const result = await client.chat({ model: "m", messages: [], stream: true }, { callbacks: { onTextDelta: (t) => void text.push(t) } });
    expect(result.content).toBe("complete");
    expect(text).toEqual(["partial ", "complete"]);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0]![0]).toMatchObject({ attempt: 1, partialOutput: true, error: { kind: "network" } });
  });

  it("treats 200 responses carrying an error object or no SSE data as provider faults (DS-07)", async () => {
    const jsonError = vi.fn(async () => jsonResponse({ error: { message: "upstream unavailable", type: "server_error" } }));
    const jsonClient = new DeepSeekClient({ apiKey: "k", baseUrl: "https://api.deepseek.com", fetchImpl: jsonError as unknown as typeof fetch, retryBaseDelayMs: 1, maxRetries: 0 });
    await expect(jsonClient.chat({ model: "m", messages: [], stream: false })).rejects.toMatchObject({
      kind: "server_error",
      retryable: true,
      message: expect.stringContaining("upstream unavailable"),
    });

    const html = vi.fn(async () => new Response("<html><body>Maintenance</body></html>", { status: 200, headers: { "content-type": "text/html" } }));
    const htmlClient = new DeepSeekClient({ apiKey: "k", baseUrl: "https://api.deepseek.com", fetchImpl: html as unknown as typeof fetch, retryBaseDelayMs: 1, maxRetries: 0 });
    await expect(htmlClient.chat({ model: "m", messages: [], stream: true })).rejects.toMatchObject({
      kind: "server_error",
      retryable: true,
      message: expect.stringContaining("Maintenance"),
    });
  });

  it("composes beta and models URLs from a /v1 or /beta base (DS-08)", () => {
    const v1 = new DeepSeekClient({ apiKey: "k", baseUrl: "https://api.deepseek.com/v1" });
    expect(v1.chatCompletionsUrl()).toBe("https://api.deepseek.com/v1/chat/completions");
    expect(v1.chatCompletionsUrl({ beta: true })).toBe("https://api.deepseek.com/beta/chat/completions");
    expect(v1.modelsUrl()).toBe("https://api.deepseek.com/v1/models");
    const beta = new DeepSeekClient({ apiKey: "k", baseUrl: "https://api.deepseek.com/beta/" });
    expect(beta.chatCompletionsUrl({ beta: true })).toBe("https://api.deepseek.com/beta/chat/completions");
    expect(beta.modelsUrl()).toBe("https://api.deepseek.com/models");
  });

  it("appends a strictTools hint to 400 errors on the beta endpoint (DS-09)", async () => {
    const fetchImpl = vi.fn(async () => new Response('{"error":{"message":"unsupported keyword minimum"}}', { status: 400 }));
    const client = new DeepSeekClient({ apiKey: "k", baseUrl: "https://api.deepseek.com", fetchImpl: fetchImpl as unknown as typeof fetch, retryBaseDelayMs: 1 });
    await expect(client.chat({ model: "m", messages: [], stream: false }, { beta: true })).rejects.toMatchObject({
      kind: "invalid_request",
      message: expect.stringContaining("strictTools"),
    });
  });
});

describe("streamed tool_call reassembly (DS-03)", () => {
  it("assigns repeated names and splits calls that share an index but carry distinct ids", async () => {
    const chunks = [
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "read_file", arguments: '{"path":' } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: "read_file", arguments: '"a"}' } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c2", function: { name: "read_file", arguments: '{"path":"b"}' } }] } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    ];
    const fetchImpl = vi.fn(async () => sseResponse(chunks));
    const client = new DeepSeekClient({ apiKey: "k", baseUrl: "https://api.deepseek.com", fetchImpl: fetchImpl as unknown as typeof fetch });
    const result = await client.chat({ model: "m", messages: [], stream: true });
    expect(result.toolCalls).toEqual([
      { id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"a"}' } },
      { id: "c2", type: "function", function: { name: "read_file", arguments: '{"path":"b"}' } },
    ]);
  });
});

describe("parseUsage with gateway nulls (DS-04)", () => {
  it("never zeroes the input side when cache fields are null", () => {
    const usage = parseUsage({ prompt_tokens: 100, completion_tokens: 5, prompt_cache_miss_tokens: null, prompt_cache_hit_tokens: null });
    expect(usage).toMatchObject({ promptTokens: 100, cacheHitTokens: 0, cacheMissTokens: 100, completionTokens: 5 });
    const short = parseUsage({ prompt_tokens: 100, prompt_cache_hit_tokens: 30, prompt_cache_miss_tokens: 10 });
    expect(short.cacheMissTokens).toBe(70);
  });
});
