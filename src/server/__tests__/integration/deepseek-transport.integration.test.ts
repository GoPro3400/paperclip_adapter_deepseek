/**
 * Integration tests: the real adapter (executeWith / testEnvironmentWith) talking
 * over real HTTP to a fake DeepSeek API and a fake Paperclip control plane, both
 * node:http servers on ephemeral 127.0.0.1 ports. No fetch mocking.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AdapterExecutionResult, AdapterInvocationMeta } from "@paperclipai/adapter-utils";
import type { ExtendedExecutionContext } from "../../compat.js";
import type { DeepSeekRunEvent } from "../../events.js";
import { executeWith } from "../../execute.js";
import { DeepSeekSessionStore } from "../../session-store.js";
import { testEnvironmentWith } from "../../test.js";
import {
  DEFAULT_USAGE,
  FakeDeepSeekServer,
  FakePaperclipServer,
  apiError,
  jsonCompletion,
  splitInsideMultibyte,
  sse,
  textTurn,
  toolCallTurn,
  type RecordedRequest,
} from "./fake-servers.js";

const API_KEY = "sk-fake-deepseek-key-for-tests";
const RUN_TOKEN = "jwt-fake-paperclip-run-token";

let deepseek: FakeDeepSeekServer;
let paperclip: FakePaperclipServer;
let cwd: string;
let sessionsDir: string;
let savedApiUrl: string | undefined;
const savedRuntimeApiUrl = process.env.PAPERCLIP_RUNTIME_API_URL;

interface Captured {
  logs: string[];
  meta: AdapterInvocationMeta[];
}

type LoggedEvent = DeepSeekRunEvent & Record<string, unknown>;

function eventsOf(captured: Captured): LoggedEvent[] {
  return captured.logs
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as LoggedEvent);
}

function eventsOfType<T extends DeepSeekRunEvent["type"]>(captured: Captured, type: T): Array<Extract<DeepSeekRunEvent, { type: T }>> {
  return eventsOf(captured).filter((event): event is Extract<LoggedEvent, { type: T }> => event.type === type);
}

function messagesOf(request: RecordedRequest): Array<Record<string, unknown>> {
  return (request.json?.messages ?? []) as Array<Record<string, unknown>>;
}

function makeContext(options: {
  captured: Captured;
  cwd?: string;
  config?: Record<string, unknown>;
  context?: Record<string, unknown>;
  sessionParams?: Record<string, unknown> | null;
  signal?: AbortSignal;
  runId?: string;
}): ExtendedExecutionContext {
  const workDir = options.cwd ?? cwd;
  return {
    runId: options.runId ?? "run-int-1",
    agent: { id: "agent-1", companyId: "company-1", name: "DeepSeek Coder", adapterType: "deepseek_api", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: options.sessionParams ?? null, sessionDisplayId: null, taskKey: null },
    config: {
      cwd: workDir,
      model: "deepseek-v4-flash",
      baseUrl: deepseek.baseUrl,
      stream: true,
      sessionsDir,
      env: { DEEPSEEK_API_KEY: { type: "plain", value: API_KEY } },
      ...(options.config ?? {}),
    },
    context: {
      taskId: "issue-42",
      wakeReason: "issue_assigned",
      paperclipWorkspace: { cwd: workDir, source: "configured" },
      ...(options.context ?? {}),
    },
    authToken: RUN_TOKEN,
    ...(options.signal ? { signal: options.signal } : {}),
    onLog: async (_stream, chunk) => {
      options.captured.logs.push(chunk);
    },
    onMeta: async (meta) => {
      options.captured.meta.push(meta);
    },
  };
}

/** Saturday 12:00 UTC: always an off-peak DeepSeek pricing window. */
const OFF_PEAK = new Date(Date.UTC(2026, 8, 12, 12, 0, 0));

async function run(ctx: ExtendedExecutionContext): Promise<AdapterExecutionResult> {
  // processEnv: {} keeps the real environment (and any real DEEPSEEK_API_KEY) out of the run.
  // The clock is pinned because DeepSeek doubles its rates in peak windows, so
  // an unpinned run would report a different cost depending on the hour.
  return executeWith(ctx, { processEnv: {}, retryBaseDelayMs: 1, now: () => OFF_PEAK });
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

beforeEach(async () => {
  deepseek = await FakeDeepSeekServer.start();
  paperclip = await FakePaperclipServer.start();
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), "deepseek-int-cwd-"));
  sessionsDir = await fs.mkdtemp(path.join(os.tmpdir(), "deepseek-int-sessions-"));
  // buildPaperclipEnv() derives PAPERCLIP_API_URL from the server process env.
  savedApiUrl = process.env.PAPERCLIP_API_URL;
  process.env.PAPERCLIP_API_URL = paperclip.baseUrl;
  delete process.env.PAPERCLIP_RUNTIME_API_URL;
});

afterEach(async () => {
  if (savedApiUrl === undefined) delete process.env.PAPERCLIP_API_URL;
  else process.env.PAPERCLIP_API_URL = savedApiUrl;
  if (savedRuntimeApiUrl !== undefined) process.env.PAPERCLIP_RUNTIME_API_URL = savedRuntimeApiUrl;
  await Promise.all([deepseek.close(), paperclip.close()]);
  await fs.rm(cwd, { recursive: true, force: true });
  await fs.rm(sessionsDir, { recursive: true, force: true });
});

describe("streaming heartbeat against real HTTP servers", () => {
  it("runs a multi-turn tool-calling heartbeat with paperclip_api, workspace tools and finish_run", async () => {
    deepseek.enqueue(
      sse(toolCallTurn([{ id: "call_me", name: "paperclip_api", args: { method: "GET", path: "/api/agents/me" } }], { reasoning: "First confirm who I am." })),
      sse(toolCallTurn([{ id: "call_inbox", name: "paperclip_api", args: { method: "GET", path: "/api/agents/me/inbox-lite" } }], { reasoning: "Check the inbox." })),
      sse(toolCallTurn([{ id: "call_checkout", name: "paperclip_api", args: { method: "POST", path: "/api/issues/issue-42/checkout", body: { agentId: "agent-1", expectedStatuses: ["todo"] } } }], { reasoning: "Take the issue." })),
      sse(toolCallTurn([{ id: "call_ctx", name: "paperclip_api", args: { method: "GET", path: "/api/issues/issue-42/heartbeat-context" } }])),
      sse(toolCallTurn([{ id: "call_write", name: "write_file", args: { path: "notes/hello.txt", content: "hello from deepseek\n" } }], { reasoning: "Write the file." })),
      sse(toolCallTurn([{ id: "call_read", name: "read_file", args: { path: "notes/hello.txt" } }])),
      sse(toolCallTurn([{ id: "call_shell", name: "run_shell", args: { command: "cat notes/hello.txt && echo shell-ok" } }], { reasoning: "Verify with the shell." })),
      sse(
        toolCallTurn([
          { id: "call_comment", name: "paperclip_api", args: { method: "POST", path: "/api/issues/issue-42/comments", body: { body: "Wrote notes/hello.txt and verified it." } } },
          { id: "call_patch", name: "paperclip_api", args: { method: "PATCH", path: "/api/issues/issue-42", body: { status: "done" } } },
        ]),
      ),
      sse(toolCallTurn([{ id: "call_finish", name: "finish_run", args: { disposition: "done", summary: "Created notes/hello.txt and closed issue-42.", issue_id: "issue-42" } }], { reasoning: "All done.", text: "Wrapping up now." })),
    );

    const captured: Captured = { logs: [], meta: [] };
    const result = await run(makeContext({ captured }));

    expect(result.errorMessage).toBeNull();
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.provider).toBe("deepseek");
    expect(result.billingType).toBe("api");
    expect(result.model).toBe("deepseek-v4-flash");
    expect(result.summary).toBe("Created notes/hello.txt and closed issue-42.");
    // 9 turns × the fixed usage chunk.
    expect(result.usage).toEqual({ inputTokens: 9 * 400, cachedInputTokens: 9 * 600, outputTokens: 9 * 100 });
    expect(result.usageBasis).toBe("per_run");
    expect(result.costUsd).toBeCloseTo((9 * 600 * 0.003 + 9 * 400 * 0.15 + 9 * 100 * 0.6) / 1e6, 10);
    expect(result.cacheAdjustedCostUsd).toBe(result.costUsd);
    const resultJson = result.resultJson as Record<string, unknown>;
    expect(resultJson.stopReason).toBe("finish_run");
    expect(resultJson.disposition).toBe("done");
    expect(resultJson.turns).toBe(9);
    expect(resultJson.toolCalls).toBe(10);
    expect(resultJson.toolErrors).toBe(0);
    expect(resultJson.usage).toMatchObject({ reasoningTokens: 9 * 30 });

    // Session params + transcript on disk.
    const params = result.sessionParams as Record<string, unknown>;
    expect(result.sessionId).toBe(params.sessionId);
    expect(params.cwd).toBe(cwd);
    expect(params.model).toBe("deepseek-v4-flash");
    expect(String(params.transcriptPath).startsWith(sessionsDir)).toBe(true);
    // user + 8 × (assistant + tool) + (assistant + 2 tools) - the two-call turn is counted once.
    expect(params.messageCount).toBe(1 + 8 * 2 + 3);
    const transcript = JSON.parse(await fs.readFile(String(params.transcriptPath), "utf8")) as Record<string, unknown>;
    expect(transcript.version).toBe(1);
    expect(transcript.runs).toBe(1);
    expect(transcript.lastRunId).toBe("run-int-1");
    expect(transcript.cwd).toBe(cwd);
    const stored = transcript.messages as Array<Record<string, unknown>>;
    expect(stored[0]).toMatchObject({ role: "user" });
    expect(String(stored[0]!.content)).toContain("issue-42");
    expect(stored[1]).toMatchObject({ role: "assistant", reasoning_content: "First confirm who I am." });
    expect((stored[1]!.tool_calls as Array<Record<string, unknown>>)[0]).toMatchObject({ id: "call_me", type: "function" });
    expect(stored[2]).toMatchObject({ role: "tool", tool_call_id: "call_me" });
    expect(stored.at(-2)).toMatchObject({ role: "assistant", content: "Wrapping up now.", reasoning_content: "All done." });
    expect(stored.at(-1)).toMatchObject({ role: "tool", tool_call_id: "call_finish" });
    expect(transcript.usageTotals).toMatchObject({ promptTokens: 9000, cacheHitTokens: 5400, cacheMissTokens: 3600, completionTokens: 900, reasoningTokens: 270 });

    // Workspace tools really touched the temp cwd.
    expect(await fs.readFile(path.join(cwd, "notes", "hello.txt"), "utf8")).toBe("hello from deepseek\n");

    // DeepSeek transport: every request is a streaming POST with the key and the thinking fields.
    const chat = deepseek.chatRequests;
    expect(chat).toHaveLength(9);
    for (const request of chat) {
      expect(request.path).toBe("/chat/completions");
      expect(request.headers.authorization).toBe(`Bearer ${API_KEY}`);
      expect(request.headers.accept).toBe("text/event-stream");
      expect(request.headers["content-type"]).toBe("application/json");
      expect(request.json).toMatchObject({
        model: "deepseek-v4-flash",
        stream: true,
        stream_options: { include_usage: true },
        thinking: { type: "enabled" },
        reasoning_effort: "high",
        tool_choice: "auto",
      });
      expect(request.json!.temperature).toBeUndefined();
    }
    const firstMessages = messagesOf(chat[0]!);
    expect(firstMessages[0]!.role).toBe("system");
    expect(String(firstMessages[0]!.content)).toContain(paperclip.baseUrl);
    expect(firstMessages[1]!.role).toBe("user");
    const toolNames = (chat[0]!.json!.tools as Array<{ function: { name: string; strict?: boolean } }>).map((tool) => tool.function.name);
    expect(toolNames).toEqual(expect.arrayContaining(["paperclip_api", "run_shell", "read_file", "write_file", "edit_file", "list_directory", "search_files", "load_skill", "finish_run"]));
    expect((chat[0]!.json!.tools as Array<{ function: { strict?: boolean } }>).every((tool) => tool.function.strict === undefined)).toBe(true);
    // The tool result of the previous turn is replayed with the assistant turn (reasoning_content kept).
    const secondMessages = messagesOf(chat[1]!);
    expect(secondMessages.at(-2)).toMatchObject({ role: "assistant", reasoning_content: "First confirm who I am." });
    expect(secondMessages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "call_me" });
    expect(JSON.parse(String(secondMessages.at(-1)!.content))).toMatchObject({ ok: true, status: 200, body: { id: "agent-1" } });
    // The two-call turn is replayed as one assistant message with both calls, followed by both tool results in order.
    const lastMessages = messagesOf(chat[8]!);
    const twoCallAssistant = lastMessages.at(-3)!;
    expect((twoCallAssistant.tool_calls as Array<Record<string, unknown>>).map((call) => call.id)).toEqual(["call_comment", "call_patch"]);
    expect(lastMessages.at(-2)).toMatchObject({ role: "tool", tool_call_id: "call_comment" });
    expect(lastMessages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "call_patch" });

    // Paperclip control plane: auth on every call, audit header on mutating calls only.
    const seen = paperclip.requests.map((request) => `${request.method} ${request.path}`);
    expect(seen).toEqual([
      "GET /api/agents/me",
      "GET /api/agents/me/inbox-lite",
      "POST /api/issues/issue-42/checkout",
      "GET /api/issues/issue-42/heartbeat-context",
      "POST /api/issues/issue-42/comments",
      "PATCH /api/issues/issue-42",
    ]);
    for (const request of paperclip.requests) {
      expect(request.headers.authorization).toBe(`Bearer ${RUN_TOKEN}`);
      expect(request.headers.accept).toBe("application/json");
    }
    for (const request of paperclip.mutatingRequests) {
      expect(request.headers["x-paperclip-run-id"]).toBe("run-int-1");
      expect(request.headers["content-type"]).toBe("application/json");
    }
    expect(paperclip.requests[0]!.headers["x-paperclip-run-id"]).toBeUndefined();
    expect(paperclip.mutatingRequests[0]!.json).toEqual({ agentId: "agent-1", expectedStatuses: ["todo"] });
    expect(paperclip.mutatingRequests[1]!.json).toEqual({ body: "Wrote notes/hello.txt and verified it." });
    expect(paperclip.mutatingRequests[2]!.json).toEqual({ status: "done" });
    expect(paperclip.state.issues["issue-42"]!.status).toBe("done");

    // Run log: structured JSONL events with streamed deltas.
    const events = eventsOf(captured);
    expect(events[0]!.type).toBe("deepseek.init");
    expect(events[0]).toMatchObject({ resumed: false, model: "deepseek-v4-flash", baseUrl: deepseek.baseUrl, historyMessages: 0 });
    expect(events.at(-1)!.type).toBe("deepseek.result");
    expect(events.at(-1)).toMatchObject({ status: "completed", stopReason: "finish_run", disposition: "done", turns: 9 });
    const thinking = eventsOfType(captured, "deepseek.thinking_delta").map((event) => event.text);
    expect(thinking.length).toBeGreaterThan(5);
    expect(thinking.join("")).toBe("First confirm who I am.Check the inbox.Take the issue.Write the file.Verify with the shell.All done.");
    const text = eventsOfType(captured, "deepseek.text_delta").map((event) => event.text);
    expect(text.length).toBeGreaterThan(1);
    expect(text.join("")).toBe("Wrapping up now.");
    // Streaming mode never emits the whole-message variants.
    expect(eventsOfType(captured, "deepseek.thinking")).toHaveLength(0);
    expect(eventsOfType(captured, "deepseek.assistant")).toHaveLength(0);
    const toolCalls = eventsOfType(captured, "deepseek.tool_call");
    expect(toolCalls.map((event) => event.name)).toEqual([
      "paperclip_api", "paperclip_api", "paperclip_api", "paperclip_api", "write_file", "read_file", "run_shell", "paperclip_api", "paperclip_api", "finish_run",
    ]);
    expect(toolCalls[4]!.input).toEqual({ path: "notes/hello.txt", content: "hello from deepseek\n" });
    const toolResults = eventsOfType(captured, "deepseek.tool_result");
    expect(toolResults).toHaveLength(10);
    expect(toolResults.every((event) => !event.isError)).toBe(true);
    const shellResult = JSON.parse(toolResults.find((event) => event.name === "run_shell")!.output) as Record<string, unknown>;
    expect(shellResult).toMatchObject({ ok: true, exit_code: 0, stdout: "hello from deepseek\nshell-ok\n" });
    const readResult = JSON.parse(toolResults.find((event) => event.name === "read_file")!.output) as Record<string, unknown>;
    expect(readResult).toMatchObject({ ok: true, content: "hello from deepseek\n", total_lines: 1 });
    const turns = eventsOfType(captured, "deepseek.turn");
    expect(turns).toHaveLength(9);
    expect(turns[7]).toMatchObject({ turn: 8, finishReason: "tool_calls", toolCalls: 2, usage: { promptTokens: 1000, cacheHitTokens: 600, cacheMissTokens: 400, completionTokens: 100, reasoningTokens: 30 } });

    // Secrets never appear in the run log or invocation meta.
    const joined = captured.logs.join("");
    expect(joined).not.toContain(API_KEY);
    expect(joined).not.toContain(RUN_TOKEN);
    expect(captured.meta).toHaveLength(1);
    expect(captured.meta[0]!.env!.PAPERCLIP_API_URL).toBe(paperclip.baseUrl);
    expect(captured.meta[0]!.env!.PAPERCLIP_API_KEY).toBe("***REDACTED***");
    expect(captured.meta[0]!.env!.DEEPSEEK_API_KEY).toBeUndefined();
    expect(captured.meta[0]!.context).toMatchObject({ deepseek: { baseUrl: deepseek.baseUrl, resumed: false, sessionId: params.sessionId } });
  });

  it("reassembles tool-call arguments split across many SSE chunks and inside multi-byte UTF-8 sequences", async () => {
    const fileName = "héllo-日本語-🚀.txt";
    const content = "first line ✓\nsecond line — 日本 🚀🎉\nthird\n";
    const argsJson = JSON.stringify({ path: fileName, content });
    deepseek.enqueue(
      sse(
        toolCallTurn([{ id: "call_write_utf8", name: "write_file", args: argsJson, fragmentSize: 3 }], { reasoning: "Écrire le fichier 日本語 🚀." }),
        { split: splitInsideMultibyte(["é", "日", "本", "語", "🚀", "🎉", "✓", "—", "É"]) },
      ),
      sse(toolCallTurn([{ id: "call_read_utf8", name: "read_file", args: { path: fileName }, fragmentSize: 2 }]), { split: splitInsideMultibyte(["é", "日", "本", "語", "🚀"]) }),
      sse(textTurn("Done: wrote the UTF-8 file 🚀.", { reasoning: "Fini." }), { split: splitInsideMultibyte(["🚀"]) }),
    );

    const captured: Captured = { logs: [], meta: [] };
    const result = await run(makeContext({ captured }));

    expect(result.errorMessage).toBeNull();
    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("Done: wrote the UTF-8 file 🚀.");
    expect(await fs.readFile(path.join(cwd, fileName), "utf8")).toBe(content);

    // The arguments handed to the tool are the exact concatenation of the fragments.
    const toolCalls = eventsOfType(captured, "deepseek.tool_call");
    expect(toolCalls[0]!.input).toEqual({ path: fileName, content });
    expect(toolCalls[1]!.input).toEqual({ path: fileName });
    const readOutput = JSON.parse(eventsOfType(captured, "deepseek.tool_result")[1]!.output) as Record<string, unknown>;
    expect(readOutput).toMatchObject({ ok: true, content });
    // ... and the assistant message replayed to the API carries the same raw JSON string.
    const replayed = messagesOf(deepseek.chatRequests[1]!).at(-2)!;
    expect((replayed.tool_calls as Array<{ function: { arguments: string; name: string } }>)[0]!.function).toEqual({ name: "write_file", arguments: argsJson });
    expect(replayed.reasoning_content).toBe("Écrire le fichier 日本語 🚀.");
    expect(eventsOfType(captured, "deepseek.thinking_delta").map((event) => event.text).join("")).toBe("Écrire le fichier 日本語 🚀.Fini.");
    expect(eventsOfType(captured, "deepseek.text_delta").map((event) => event.text).join("")).toBe("Done: wrote the UTF-8 file 🚀.");
    // The multi-byte split really happened: the server used more socket writes
    // than there were SSE events, and several write boundaries fell inside a
    // UTF-8 sequence (the next write started with a continuation byte).
    expect(deepseek.chatRequests).toHaveLength(3);
    const firstTurn = deepseek.chatRequests[0]!;
    const eventCount = toolCallTurn([{ id: "call_write_utf8", name: "write_file", args: argsJson, fragmentSize: 3 }], { reasoning: "x" }).length + 1;
    expect(firstTurn.writes).toBeGreaterThan(eventCount);
    expect(firstTurn.midCodepointCuts).toBeGreaterThanOrEqual(10);
    expect(deepseek.chatRequests[2]!.midCodepointCuts).toBeGreaterThanOrEqual(1);
    // The argument fragments were 3 code points wide, so the tool-call delta count proves the reassembly path was exercised.
    expect(Array.from(argsJson).length / 3).toBeGreaterThan(20);
  });
});

describe("HTTP error handling", () => {
  it("retries a 429 (honouring Retry-After) and then completes, logging a deepseek.warning", async () => {
    deepseek.enqueue(
      apiError(429, "Rate limit reached for requests", { type: "rate_limit_error", headers: { "retry-after": "1" } }),
      sse(textTurn("Recovered after the rate limit.", { reasoning: "ok" })),
    );
    const captured: Captured = { logs: [], meta: [] };
    const startedAt = Date.now();
    const result = await run(makeContext({ captured }));
    const elapsed = Date.now() - startedAt;

    expect(result.errorMessage).toBeNull();
    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("Recovered after the rate limit.");
    expect(deepseek.chatRequests).toHaveLength(2);
    expect(elapsed).toBeGreaterThanOrEqual(900);
    // Both attempts send the identical request body.
    expect(deepseek.chatRequests[1]!.body).toBe(deepseek.chatRequests[0]!.body);
    const warnings = eventsOfType(captured, "deepseek.warning").map((event) => event.message);
    expect(warnings.some((message) => /DeepSeek request failed \(DeepSeek API error 429: Rate limit reached for requests\); retry 1\/4 in 1s\./.test(message))).toBe(true);
    expect(eventsOfType(captured, "deepseek.error")).toHaveLength(0);
    expect(eventsOf(captured).at(-1)).toMatchObject({ type: "deepseek.result", status: "completed" });
  });

  it("gives up after maxRetries on persistent 429s and reports deepseek_rate_limited with retryNotBefore", async () => {
    deepseek.setFallback(apiError(429, "Rate limit reached for requests", { type: "rate_limit_error", headers: { "retry-after": "0" } }));
    const captured: Captured = { logs: [], meta: [] };
    const before = Date.now();
    const result = await run(makeContext({ captured, config: { maxRetries: 2 } }));

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("deepseek_rate_limited");
    expect(result.errorFamily).toBe("transient_upstream");
    expect(result.errorMessage).toBe("DeepSeek API error 429: Rate limit reached for requests");
    expect(typeof result.retryNotBefore).toBe("string");
    expect(Date.parse(result.retryNotBefore!)).toBeGreaterThanOrEqual(before + 60_000 - 5);
    // 1 initial attempt + 2 retries, each announced with a warning.
    expect(deepseek.chatRequests).toHaveLength(3);
    const retries = eventsOfType(captured, "deepseek.warning").filter((event) => /retry \d\/2/.test(event.message));
    expect(retries.map((event) => event.message.match(/retry (\d)\/2/)![1])).toEqual(["1", "2"]);
    expect(eventsOfType(captured, "deepseek.error")[0]).toMatchObject({ code: "rate_limited" });
    expect(eventsOf(captured).at(-1)).toMatchObject({ type: "deepseek.result", status: "error" });
  });

  it("retries a 5xx and continues once the server recovers", async () => {
    deepseek.enqueue(
      apiError(503, "Server is overloaded", { type: "server_error" }),
      apiError(500, "Internal error", { type: "server_error" }),
      sse(toolCallTurn([{ id: "call_after_5xx", name: "write_file", args: { path: "after-5xx.txt", content: "recovered\n" } }])),
      sse(textTurn("Recovered after 5xx.")),
    );
    const captured: Captured = { logs: [], meta: [] };
    const result = await run(makeContext({ captured }));

    expect(result.errorMessage).toBeNull();
    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("Recovered after 5xx.");
    expect(await fs.readFile(path.join(cwd, "after-5xx.txt"), "utf8")).toBe("recovered\n");
    expect(deepseek.chatRequests).toHaveLength(4);
    // The three attempts of the first turn carry the same body; the 4th request is the next turn.
    expect(deepseek.chatRequests[1]!.body).toBe(deepseek.chatRequests[0]!.body);
    expect(deepseek.chatRequests[2]!.body).toBe(deepseek.chatRequests[0]!.body);
    expect(messagesOf(deepseek.chatRequests[3]!).at(-1)).toMatchObject({ role: "tool", tool_call_id: "call_after_5xx" });
    const warnings = eventsOfType(captured, "deepseek.warning").map((event) => event.message);
    expect(warnings.filter((message) => /retry \d\/4/.test(message))).toHaveLength(2);
    expect(warnings[0]).toContain("503: Server is overloaded");
    expect(warnings[1]).toContain("500: Internal error");
    expect(eventsOfType(captured, "deepseek.error")).toHaveLength(0);
  });

  it("maps a 402 to deepseek_insufficient_balance / provider_quota without retrying", async () => {
    deepseek.enqueue(apiError(402, "Insufficient Balance", { type: "insufficient_quota" }));
    deepseek.setFallback(sse(textTurn("should never be requested")));
    const captured: Captured = { logs: [], meta: [] };
    const result = await run(makeContext({ captured }));

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("deepseek_insufficient_balance");
    expect(result.errorFamily).toBe("provider_quota");
    expect(result.errorMessage).toBe("DeepSeek API error 402: Insufficient Balance");
    expect(result.timedOut).toBe(false);
    expect(deepseek.chatRequests).toHaveLength(1);
    expect(eventsOfType(captured, "deepseek.warning").filter((event) => /retry/.test(event.message))).toHaveLength(0);
    expect(eventsOfType(captured, "deepseek.error")[0]).toMatchObject({ code: "insufficient_balance" });
    expect(eventsOf(captured).at(-1)).toMatchObject({ type: "deepseek.result", status: "error", errors: ["DeepSeek API error 402: Insufficient Balance"] });
    // A failed first turn still leaves a resumable session (the user prompt is persisted).
    expect((result.sessionParams as Record<string, unknown>).messageCount).toBe(1);
    expect((result.resultJson as Record<string, unknown>).error).toEqual({ message: "DeepSeek API error 402: Insufficient Balance", kind: "insufficient_balance", status: 402 });
  });

  it("maps a 401 to deepseek_auth_failed with no retries", async () => {
    deepseek.enqueue(apiError(401, "Authentication Fails, Your api key is invalid", { type: "authentication_error" }));
    deepseek.setFallback(sse(textTurn("should never be requested")));
    const captured: Captured = { logs: [], meta: [] };
    const result = await run(makeContext({ captured }));

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("deepseek_auth_failed");
    expect(result.errorFamily).toBeNull();
    expect(result.errorMessage).toBe("DeepSeek API error 401: Authentication Fails, Your api key is invalid");
    expect(result.retryNotBefore).toBeUndefined();
    expect(deepseek.chatRequests).toHaveLength(1);
    expect(eventsOfType(captured, "deepseek.warning").filter((event) => /retry/.test(event.message))).toHaveLength(0);
    expect(eventsOfType(captured, "deepseek.error")[0]).toMatchObject({ code: "auth" });
  });

  it("drops reasoning_content from older assistant turns after a 400 that rejects the history shape", async () => {
    // Seed a transcript from an earlier heartbeat whose assistant turn carries reasoning_content.
    const store = new DeepSeekSessionStore(sessionsDir);
    const seeded = store.create({ agentId: "agent-1", companyId: "company-1", cwd, model: "deepseek-v4-flash", adapterType: "deepseek_api" });
    seeded.messages = [
      { role: "user", content: "Earlier heartbeat prompt." },
      { role: "assistant", content: "Earlier heartbeat finished.", reasoning_content: "old private thoughts" },
    ];
    seeded.runs = 1;
    await store.save(seeded);

    deepseek.enqueue(
      apiError(400, "The reasoning_content field is only allowed on assistant messages of the current tool-calling round", { type: "invalid_request_error", code: "invalid_request_error" }),
      sse(toolCallTurn([{ id: "call_w", name: "write_file", args: { path: "after-400.txt", content: "ok\n" } }], { reasoning: "current round thoughts" })),
      sse(textTurn("Continued after the 400.", { reasoning: "final thoughts" })),
    );
    const captured: Captured = { logs: [], meta: [] };
    const result = await run(makeContext({ captured, sessionParams: store.toSessionParams(seeded) }));

    expect(result.errorMessage).toBeNull();
    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("Continued after the 400.");
    expect(eventsOf(captured)[0]).toMatchObject({ type: "deepseek.init", resumed: true, historyMessages: 2 });
    expect(await fs.readFile(path.join(cwd, "after-400.txt"), "utf8")).toBe("ok\n");

    const chat = deepseek.chatRequests;
    expect(chat).toHaveLength(3);
    const oldAssistant = (request: RecordedRequest) => messagesOf(request).find((message) => message.role === "assistant" && message.content === "Earlier heartbeat finished.")!;
    // Attempt 1 (rejected): the older assistant turn carried its stored reasoning_content.
    expect(oldAssistant(chat[0]!)).toMatchObject({ reasoning_content: "old private thoughts" });
    // Attempt 2 (retried with policy current_round): identical conversation, but no reasoning_content on the older turn.
    expect(oldAssistant(chat[1]!)).toBeDefined();
    expect("reasoning_content" in oldAssistant(chat[1]!)).toBe(false);
    expect(messagesOf(chat[1]!).length).toBe(messagesOf(chat[0]!).length);
    expect(messagesOf(chat[1]!).at(-1)).toMatchObject({ role: "user" });
    // Request 3 keeps reasoning_content on the current-round assistant turn only.
    expect("reasoning_content" in oldAssistant(chat[2]!)).toBe(false);
    const currentRound = messagesOf(chat[2]!).at(-2)!;
    expect(currentRound).toMatchObject({ role: "assistant", reasoning_content: "current round thoughts" });
    expect((currentRound.tool_calls as Array<Record<string, unknown>>)[0]).toMatchObject({ id: "call_w" });

    const warnings = eventsOfType(captured, "deepseek.warning").map((event) => event.message);
    expect(warnings.some((message) => message.includes('retrying with policy "current_round"') && message.includes("400"))).toBe(true);
    expect((result.resultJson as Record<string, unknown>).reasoningPolicy).toBe("current_round");
    // The transcript still stores the reasoning of the turn that produced it.
    const transcript = JSON.parse(await fs.readFile(String((result.sessionParams as Record<string, unknown>).transcriptPath), "utf8")) as { messages: Array<Record<string, unknown>>; runs: number };
    expect(transcript.runs).toBe(2);
    expect(transcript.messages[1]).toMatchObject({ reasoning_content: "old private thoughts" });
    expect(transcript.messages.at(-1)).toMatchObject({ role: "assistant", content: "Continued after the 400.", reasoning_content: "final thoughts" });
  });
});

describe("session resume", () => {
  it("resumes with the earlier messages when the cwd matches and starts fresh when it does not", async () => {
    deepseek.enqueue(sse(textTurn("First run done.", { reasoning: "run one" })));
    const first: Captured = { logs: [], meta: [] };
    const firstResult = await run(makeContext({ captured: first, runId: "run-a" }));
    expect(firstResult.exitCode).toBe(0);
    const params = firstResult.sessionParams as Record<string, unknown>;
    expect(params.messageCount).toBe(2);
    expect(eventsOf(first)[0]).toMatchObject({ type: "deepseek.init", resumed: false, historyMessages: 0 });
    const firstUserPrompt = String(messagesOf(deepseek.chatRequests[0]!)[1]!.content);

    // Run 2: same cwd, sessionParams from run 1.
    deepseek.enqueue(sse(textTurn("Second run done.", { reasoning: "run two" })));
    const second: Captured = { logs: [], meta: [] };
    const secondResult = await run(makeContext({ captured: second, runId: "run-b", sessionParams: params, context: { wakeReason: "timer" } }));
    expect(secondResult.exitCode).toBe(0);
    expect(secondResult.sessionId).toBe(params.sessionId);
    expect(eventsOf(second)[0]).toMatchObject({ type: "deepseek.init", resumed: true, historyMessages: 2, sessionId: params.sessionId });
    const resumedMessages = messagesOf(deepseek.chatRequests[1]!);
    expect(resumedMessages).toHaveLength(4);
    expect(resumedMessages[0]!.role).toBe("system");
    expect(resumedMessages[1]).toEqual({ role: "user", content: firstUserPrompt });
    expect(resumedMessages[2]).toMatchObject({ role: "assistant", content: "First run done.", reasoning_content: "run one" });
    expect(resumedMessages[3]!.role).toBe("user");
    expect(String(resumedMessages[3]!.content)).toContain("run-b");
    const secondParams = secondResult.sessionParams as Record<string, unknown>;
    expect(secondParams.sessionId).toBe(params.sessionId);
    expect(secondParams.messageCount).toBe(4);
    expect(secondParams.transcriptPath).toBe(params.transcriptPath);
    const transcript = JSON.parse(await fs.readFile(String(params.transcriptPath), "utf8")) as Record<string, unknown>;
    expect(transcript.runs).toBe(2);
    expect(transcript.lastRunId).toBe("run-b");
    expect((transcript.messages as unknown[]).length).toBe(4);
    expect(second.meta[0]!.commandNotes!.some((note) => note.startsWith(`Resumed session ${params.sessionId} with 2 stored messages`))).toBe(true);

    // Run 3: different cwd → fresh session.
    const otherCwd = await fs.mkdtemp(path.join(os.tmpdir(), "deepseek-int-other-"));
    try {
      deepseek.enqueue(sse(textTurn("Third run in a new place.")));
      const third: Captured = { logs: [], meta: [] };
      const thirdResult = await run(makeContext({ captured: third, runId: "run-c", cwd: otherCwd, sessionParams: secondParams }));
      expect(thirdResult.exitCode).toBe(0);
      const init = eventsOf(third)[0]!;
      expect(init).toMatchObject({ type: "deepseek.init", resumed: false, historyMessages: 0 });
      expect(init.sessionId).not.toBe(params.sessionId);
      expect(thirdResult.sessionId).not.toBe(params.sessionId);
      expect(messagesOf(deepseek.chatRequests[2]!)).toHaveLength(2);
      expect(third.logs.some((line) => line.includes(`Saved session ${params.sessionId} belongs to cwd "${cwd}"; starting a fresh session in "${otherCwd}".`))).toBe(true);
      expect((thirdResult.sessionParams as Record<string, unknown>).cwd).toBe(otherCwd);
      // The old transcript is untouched by the fresh session.
      const untouched = JSON.parse(await fs.readFile(String(params.transcriptPath), "utf8")) as Record<string, unknown>;
      expect(untouched.runs).toBe(2);
    } finally {
      await fs.rm(otherCwd, { recursive: true, force: true });
    }
  });
});

describe("cancellation and timeouts", () => {
  it("aborts the in-flight stream when the run signal fires and reports Run cancelled", async () => {
    deepseek.enqueue(sse(toolCallTurn([], { reasoning: "thinking before the cut" }).slice(0, -2), { holdOpen: true }));
    const controller = new AbortController();
    const captured: Captured = { logs: [], meta: [] };
    const pending = run(makeContext({ captured, signal: controller.signal }));

    await deepseek.waitFor((requests) => requests.some((request) => request.held));
    // The preamble was streamed before the cut.
    await waitUntil(() => eventsOfType(captured, "deepseek.thinking_delta").map((event) => event.text).join("") === "thinking before the cut");
    controller.abort(new Error("operator stop"));

    const result = await pending;
    expect(result.exitCode).toBeNull();
    expect(result.signal).toBe("SIGTERM");
    expect(result.timedOut).toBe(false);
    expect(result.errorMessage).toBe("Run cancelled");
    expect((result.resultJson as Record<string, unknown>).stopReason).toBe("cancelled");
    expect(eventsOf(captured).at(-1)).toMatchObject({ type: "deepseek.result", status: "cancelled", stopReason: "cancelled", errors: ["Run cancelled"] });
    // Only one request was made and the server saw the client hang up mid-stream.
    expect(deepseek.chatRequests).toHaveLength(1);
    await deepseek.waitFor((requests) => requests[0]!.aborted === true, 3000);
    expect(deepseek.chatRequests[0]!.aborted).toBe(true);
    // The partial turn is not persisted, but the session stays resumable.
    expect((result.sessionParams as Record<string, unknown>).messageCount).toBe(1);
  });

  it("times out the heartbeat when the server stalls and reports timedOut", async () => {
    deepseek.enqueue(sse([], { holdOpen: true }));
    const captured: Captured = { logs: [], meta: [] };
    const startedAt = Date.now();
    const result = await run(makeContext({ captured, config: { timeoutSec: 1 } }));
    const elapsed = Date.now() - startedAt;

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(result.errorMessage).toBe("Timed out after 1s");
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(elapsed).toBeLessThan(10_000);
    expect((result.resultJson as Record<string, unknown>).stopReason).toBe("timeout");
    expect(eventsOf(captured).at(-1)).toMatchObject({ type: "deepseek.result", status: "timeout", errors: ["Heartbeat timed out"] });
    expect(deepseek.chatRequests).toHaveLength(1);
    await deepseek.waitFor((requests) => requests[0]!.aborted === true, 3000);
    expect(deepseek.chatRequests[0]!.aborted).toBe(true);
  });
});

describe("strict tools", () => {
  it("targets the beta endpoint with strict, all-required tool schemas and still executes tools", async () => {
    deepseek.enqueue(
      sse(toolCallTurn([{ id: "call_strict", name: "write_file", args: { path: "strict.txt", content: "strict\n", append: null } }])),
      sse(toolCallTurn([{ id: "call_strict_read", name: "read_file", args: { path: "strict.txt", offset: null, limit: null } }])),
      sse(textTurn("Strict done.")),
    );
    const captured: Captured = { logs: [], meta: [] };
    const result = await run(makeContext({ captured, config: { strictTools: true } }));

    expect(result.errorMessage).toBeNull();
    expect(result.exitCode).toBe(0);
    expect(await fs.readFile(path.join(cwd, "strict.txt"), "utf8")).toBe("strict\n");
    expect(deepseek.chatRequests).toHaveLength(3);
    for (const request of deepseek.chatRequests) {
      expect(request.path).toBe("/beta/chat/completions");
      const tools = request.json!.tools as Array<{ type: string; function: { name: string; strict?: boolean; parameters: Record<string, unknown> } }>;
      expect(tools.length).toBeGreaterThan(5);
      for (const tool of tools) {
        expect(tool.type).toBe("function");
        expect(tool.function.strict).toBe(true);
        const parameters = tool.function.parameters;
        const properties = parameters.properties as Record<string, Record<string, unknown>>;
        expect(parameters.additionalProperties).toBe(false);
        expect(parameters.required).toEqual(Object.keys(properties));
      }
      const readFile = tools.find((tool) => tool.function.name === "read_file")!;
      const readProps = readFile.function.parameters.properties as Record<string, Record<string, unknown>>;
      expect(readProps.path!.type).toBe("string");
      expect(readProps.offset!.type).toEqual(["integer", "null"]);
      expect(readProps.limit!.type).toEqual(["integer", "null"]);
      const finish = tools.find((tool) => tool.function.name === "finish_run")!;
      const blocker = (finish.function.parameters.properties as Record<string, Record<string, unknown>>).blocker!;
      expect(blocker.type).toEqual(["object", "null"]);
      expect(blocker.required).toEqual(["owner", "action"]);
      expect(blocker.additionalProperties).toBe(false);
    }
    // Null-valued optional arguments (strict-mode omissions) are stripped before validation.
    const toolResults = eventsOfType(captured, "deepseek.tool_result");
    expect(toolResults.every((event) => !event.isError)).toBe(true);
    expect(JSON.parse(toolResults[1]!.output)).toMatchObject({ ok: true, content: "strict\n" });
    expect(captured.meta[0]!.commandNotes!.some((note) => note.includes("strict tools (beta endpoint)"))).toBe(true);
    // Models are still listed from the non-beta base.
    expect(deepseek.modelRequests).toHaveLength(0);
  });
});

describe("environment test", () => {
  it("passes against the fake API (models list + hello probe) and warns for an unknown model", async () => {
    deepseek.enqueue(jsonCompletion({ content: "hello" }, "stop", DEFAULT_USAGE));
    const baseConfig = { cwd, sessionsDir, baseUrl: deepseek.baseUrl, env: { DEEPSEEK_API_KEY: { type: "plain", value: API_KEY } } };
    const pass = await testEnvironmentWith({ companyId: "company-1", adapterType: "deepseek_api", config: { ...baseConfig, model: "deepseek-v4-flash" } }, { processEnv: {} });

    expect(pass.adapterType).toBe("deepseek_api");
    expect(pass.checks.filter((check) => check.level !== "info")).toEqual([]);
    expect(pass.status).toBe("pass");
    const codes = pass.checks.map((check) => check.code);
    expect(codes).toEqual(expect.arrayContaining(["deepseek_api_key_present", "deepseek_base_url", "deepseek_model_known", "deepseek_cwd_ok", "deepseek_sessions_dir", "deepseek_shell", "deepseek_auth_ok", "deepseek_model_available", "deepseek_hello_probe_ok"]));
    expect(pass.checks.find((check) => check.code === "deepseek_auth_ok")).toMatchObject({ detail: "deepseek-v4-flash, deepseek-v4-pro", message: "DeepSeek API reachable; 2 models available to this key." });
    expect(pass.checks.find((check) => check.code === "deepseek_hello_probe_ok")!.message).toContain("(reply: hello)");

    expect(deepseek.modelRequests).toHaveLength(1);
    expect(deepseek.modelRequests[0]!.headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(deepseek.chatRequests).toHaveLength(1);
    const probe = deepseek.chatRequests[0]!;
    expect(probe.path).toBe("/chat/completions");
    expect(probe.headers.accept).toBe("application/json");
    expect(probe.json).toMatchObject({ model: "deepseek-v4-flash", stream: false, thinking: { type: "disabled" }, max_tokens: 16, messages: [{ role: "user", content: "Respond with the single word: hello" }] });
    expect(probe.json!.stream_options).toBeUndefined();

    // Unknown model: the API answers the probe but the model is not in /models.
    deepseek.enqueue(jsonCompletion({ content: "hello" }));
    const warn = await testEnvironmentWith({ companyId: "company-1", adapterType: "deepseek_api", config: { ...baseConfig, model: "deepseek-v9-experimental" } }, { processEnv: {} });
    expect(warn.status).toBe("warn");
    expect(warn.checks.find((check) => check.code === "deepseek_model_custom")).toMatchObject({ level: "info" });
    expect(warn.checks.find((check) => check.code === "deepseek_model_unlisted")).toMatchObject({ level: "warn", hint: "Pick one of: deepseek-v4-flash, deepseek-v4-pro" });
    expect(warn.checks.some((check) => check.level === "error")).toBe(false);
    expect(deepseek.chatRequests).toHaveLength(2);
    expect(deepseek.chatRequests[1]!.json!.model).toBe("deepseek-v9-experimental");

    // A key that lists no models and whose probe is rejected fails the check.
    const rejecting = await FakeDeepSeekServer.start();
    try {
      rejecting.models = [];
      rejecting.setFallback(apiError(401, "Authentication Fails", { type: "authentication_error" }));
      const fail = await testEnvironmentWith({ companyId: "company-1", adapterType: "deepseek_api", config: { ...baseConfig, baseUrl: rejecting.baseUrl } }, { processEnv: {} });
      expect(fail.status).toBe("fail");
      expect(fail.checks.find((check) => check.code === "deepseek_hello_probe_failed")).toMatchObject({ level: "error" });
      expect(fail.checks.find((check) => check.code === "deepseek_model_unlisted")).toMatchObject({ level: "warn", hint: "Pick one of: (none listed)" });
      expect(rejecting.modelRequests).toHaveLength(1);
      expect(rejecting.chatRequests).toHaveLength(1);
    } finally {
      await rejecting.close();
    }
  });
});
