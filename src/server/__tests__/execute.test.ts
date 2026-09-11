import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext, AdapterInvocationMeta } from "@paperclipai/adapter-utils";
import { executeWith } from "../execute.js";
import { DeepSeekSessionStore } from "../session-store.js";
import { testEnvironmentWith } from "../test.js";
import { createServerAdapter, discoverModels, resetModelCacheForTests } from "../index.js";
import { jsonResponse } from "./helpers.js";

let cwd: string;
let sessionsDir: string;

beforeAll(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), "deepseek-exec-"));
  sessionsDir = await fs.mkdtemp(path.join(os.tmpdir(), "deepseek-exec-sessions-"));
  await fs.writeFile(path.join(cwd, "AGENTS.md"), "# Team rules\nBe precise.\n");
});

afterAll(async () => {
  await fs.rm(cwd, { recursive: true, force: true });
  await fs.rm(sessionsDir, { recursive: true, force: true });
});

interface Captured {
  logs: string[];
  meta: AdapterInvocationMeta[];
}

function makeContext(overrides: Partial<AdapterExecutionContext> & { captured: Captured; sessionParams?: Record<string, unknown> | null }): AdapterExecutionContext {
  const { captured, sessionParams, ...rest } = overrides;
  return {
    runId: "run-123",
    agent: { id: "agent-1", companyId: "company-1", name: "DeepSeek Coder", adapterType: "deepseek_api", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: sessionParams ?? null, sessionDisplayId: null, taskKey: null },
    config: {
      cwd,
      model: "deepseek-v4-flash",
      env: { DEEPSEEK_API_KEY: { type: "plain", value: "sk-secret-key-value" }, GITHUB_TOKEN: "ghp_secret_token_value" },
      sessionsDir,
      instructionsFilePath: "AGENTS.md",
      stream: false,
      timeoutSec: 60,
    },
    context: { taskId: "issue-9", wakeReason: "issue_assigned", paperclipWorkspace: { cwd, source: "configured" } },
    authToken: "jwt-run-token-value",
    onLog: async (_stream, chunk) => {
      captured.logs.push(chunk);
    },
    onMeta: async (meta) => {
      captured.meta.push(meta);
    },
    ...rest,
  };
}

/** Scripted DeepSeek + Paperclip API stub. */
function makeFetch(turns: Array<Record<string, unknown>>): { fetchImpl: typeof fetch; calls: Array<{ url: string; body: Record<string, unknown> | null; headers: Record<string, string> }> } {
  let turn = 0;
  const calls: Array<{ url: string; body: Record<string, unknown> | null; headers: Record<string, string> }> = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    let body: Record<string, unknown> | null = null;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body) as Record<string, unknown>;
      } catch {
        body = null;
      }
    }
    calls.push({ url: target, body, headers });
    if (target.startsWith("http://localhost:3100/api/")) {
      if (target.endsWith("/agents/me")) return jsonResponse({ id: "agent-1", name: "DeepSeek Coder", companyId: "company-1" });
      if (target.includes("/checkout")) return jsonResponse({ id: "issue-9", status: "in_progress" });
      if (target.includes("/comments")) return jsonResponse({ id: "comment-1" });
      return jsonResponse({ id: "issue-9", status: "done" });
    }
    if (target.endsWith("/models")) return jsonResponse({ data: [{ id: "deepseek-v4-flash" }, { id: "deepseek-v4-pro" }] });
    const scripted = turns[turn] ?? turns[turns.length - 1]!;
    turn += 1;
    return jsonResponse(scripted);
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

function completion(message: Record<string, unknown>, finishReason = "tool_calls", usage: Record<string, unknown> = { prompt_tokens: 1000, completion_tokens: 100, prompt_cache_hit_tokens: 600, prompt_cache_miss_tokens: 400 }) {
  return { id: "cmpl", model: "deepseek-v4-flash", choices: [{ index: 0, message: { role: "assistant", ...message }, finish_reason: finishReason }], usage };
}

describe("executeWith", () => {
  it("fails fast without an API key and leaves the persisted session alone", async () => {
    const captured: Captured = { logs: [], meta: [] };
    const ctx = makeContext({ captured, config: { cwd, sessionsDir }, sessionParams: { sessionId: "ds_keep", cwd, transcriptPath: "/keep" } });
    const result = await executeWith(ctx, { processEnv: {}, retryBaseDelayMs: 1 });
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("deepseek_api_key_missing");
    // No sessionParams key at all: an explicit null would make the server clear the task session.
    expect("sessionParams" in result).toBe(false);
    expect("clearSession" in result).toBe(false);
    expect((result as Record<string, unknown>).executionRecovery).toEqual({ kind: "bootstrap", providerWorkStarted: false });
  });

  it("never uses PAPERCLIP_API_KEY from the adapter config and warns in the run log when no run token was issued", async () => {
    const captured: Captured = { logs: [], meta: [] };
    const { fetchImpl, calls } = makeFetch([completion({ content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "finish_run", arguments: JSON.stringify({ disposition: "no_action", summary: "Nothing assigned." }) } }] })]);
    const ctx = makeContext({
      captured,
      authToken: undefined,
      config: { cwd, sessionsDir, stream: false, env: { DEEPSEEK_API_KEY: "sk-x", PAPERCLIP_API_KEY: "board-key-from-config" } },
    });
    const result = await executeWith(ctx, { fetchImpl, processEnv: {}, retryBaseDelayMs: 1 });
    expect(result.exitCode).toBe(0);
    expect(captured.meta[0]!.env!.PAPERCLIP_API_KEY).toBeUndefined();
    const toolNames = (calls.find((call) => call.url.endsWith("/chat/completions"))!.body!.tools as Array<{ function: { name: string } }>).map((tool) => tool.function.name);
    expect(toolNames).not.toContain("paperclip_api");
    const events = captured.logs.filter((line) => line.startsWith("{")).map((line) => JSON.parse(line) as { type: string; message?: string });
    expect(events[0]!.type).toBe("deepseek.init");
    expect(events.some((event) => event.type === "deepseek.warning" && event.message!.startsWith("Paperclip API tool unavailable: no run token was issued for this run"))).toBe(true);
    expect(captured.logs.join("")).not.toContain("board-key-from-config");
  });

  it("reports an exhausted turn budget as a failed run that keeps the session", async () => {
    const captured: Captured = { logs: [], meta: [] };
    const loop = completion({ content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "run_shell", arguments: JSON.stringify({ command: "true" }) } }] });
    const { fetchImpl } = makeFetch([loop, loop, completion({ content: "Status: tests still missing." }, "stop")]);
    const ctx = makeContext({ captured, config: { cwd, sessionsDir, stream: false, maxTurns: 2, env: { DEEPSEEK_API_KEY: "sk-x" } } });
    const result = await executeWith(ctx, { fetchImpl, processEnv: {}, retryBaseDelayMs: 1 });
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("max_turns_exhausted");
    expect(result.errorMessage).toContain("Turn limit (2)");
    expect((result.resultJson as Record<string, unknown>).stopReason).toBe("max_turns_exhausted");
    expect(result.summary).toBe("Status: tests still missing.");
    expect((result.sessionParams as Record<string, unknown>).messageCount).toBe(7);
    const last = JSON.parse(captured.logs.filter((line) => line.startsWith("{")).at(-1)!) as { type: string; status: string; stopReason: string };
    expect(last).toMatchObject({ type: "deepseek.result", status: "error", stopReason: "max_turns_exhausted" });
  });

  it("fails a run whose model produced no final response", async () => {
    const captured: Captured = { logs: [], meta: [] };
    const { fetchImpl } = makeFetch([completion({ content: "" }, "length"), completion({ content: "" }, "length")]);
    const ctx = makeContext({ captured, config: { cwd, sessionsDir, stream: false, env: { DEEPSEEK_API_KEY: "sk-x" } } });
    const result = await executeWith(ctx, { fetchImpl, processEnv: {}, retryBaseDelayMs: 1 });
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("deepseek_output_truncated");
    expect(result.summary).toBeNull();
    expect((result.sessionParams as Record<string, unknown>).sessionId).toBeDefined();
  });

  it("resumes a transcript the server migrated to a new workspace cwd", async () => {
    const store = new DeepSeekSessionStore(sessionsDir);
    const session = store.create({ agentId: "agent-1", companyId: "company-1", cwd: "/old/agent_home", model: "deepseek-v4-flash", adapterType: "deepseek_api" });
    session.messages.push({ role: "user", content: "earlier prompt" }, { role: "assistant", content: "earlier answer", reasoning_content: "r" });
    await store.save(session);
    const captured: Captured = { logs: [], meta: [] };
    const { fetchImpl, calls } = makeFetch([completion({ content: "Continuing." }, "stop")]);
    // The server rewrote sessionParams.cwd to the project workspace; the file still records the old cwd.
    const ctx = makeContext({ captured, sessionParams: { ...store.toSessionParams(session), cwd }, config: { cwd, sessionsDir, stream: false, env: { DEEPSEEK_API_KEY: "sk-x" } } });
    const result = await executeWith(ctx, { fetchImpl, processEnv: {}, retryBaseDelayMs: 1 });
    expect(result.exitCode).toBe(0);
    expect(result.sessionId).toBe(session.sessionId);
    const init = JSON.parse(captured.logs.find((line) => line.includes("deepseek.init"))!) as { resumed: boolean; historyMessages: number };
    expect(init).toMatchObject({ resumed: true, historyMessages: 2 });
    expect(captured.logs.some((line) => line.includes("continuing it in") && line.includes("session moved by Paperclip"))).toBe(true);
    expect((calls.find((call) => call.url.endsWith("/chat/completions"))!.body!.messages as unknown[]).length).toBe(4);
    const reloaded = await store.load(session.sessionId);
    expect(reloaded?.cwd).toBe(cwd);
    expect(reloaded?.reasoningPolicy).toBe("full");
  });

  it("clears a resumed session whose stored history the API rejects on the first request", async () => {
    const store = new DeepSeekSessionStore(sessionsDir);
    const session = store.create({ agentId: "agent-1", companyId: "company-1", cwd, model: "deepseek-v4-flash", adapterType: "deepseek_api" });
    session.messages.push({ role: "user", content: "earlier prompt" }, { role: "tool", tool_call_id: "orphan", content: "{}" });
    await store.save(session);
    const captured: Captured = { logs: [], meta: [] };
    const fetchImpl = vi.fn(async () => new Response('{"error":{"message":"tool_call_id orphan has no matching tool_calls","type":"invalid_request_error"}}', { status: 400 }));
    const ctx = makeContext({ captured, sessionParams: store.toSessionParams(session), config: { cwd, sessionsDir, stream: false, env: { DEEPSEEK_API_KEY: "sk-x" } } });
    const result = await executeWith(ctx, { fetchImpl: fetchImpl as unknown as typeof fetch, processEnv: {}, retryBaseDelayMs: 1 });
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("deepseek_session_rejected");
    expect(result.clearSession).toBe(true);
    expect(result.sessionParams).toBeNull();
    expect(captured.logs.some((line) => line.includes("rejected the stored conversation"))).toBe(true);
    expect(await store.load(session.sessionId)).toBeNull();
    await expect(fs.stat(`${store.transcriptPath(session.sessionId)}.rejected`)).resolves.toBeDefined();

    // A rejection after the model already answered in this run is an ordinary invalid_request failure.
    const captured2: Captured = { logs: [], meta: [] };
    const { fetchImpl: fetch2 } = makeFetch([
      completion({ content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "run_shell", arguments: JSON.stringify({ command: "true" }) } }] }),
      { error: { message: "bad request later" } },
    ]);
    const failing = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const response = await fetch2(url, init);
      const text = await response.text();
      return text.includes("bad request later") ? new Response(text, { status: 400 }) : new Response(text, { status: 200, headers: { "content-type": "application/json" } });
    });
    const later = await executeWith(makeContext({ captured: captured2, config: { cwd, sessionsDir, stream: false, env: { DEEPSEEK_API_KEY: "sk-x" } } }), { fetchImpl: failing as unknown as typeof fetch, processEnv: {}, retryBaseDelayMs: 1 });
    expect(later.errorCode).toBe("deepseek_invalid_request");
    expect(later.clearSession).toBe(false);
  });

  it("keeps the system prompt identical across wakes and lists the actual variables in the heartbeat facts", async () => {
    const script = () => makeFetch([completion({ content: "ok" }, "stop")]);
    const first = script();
    const captured1: Captured = { logs: [], meta: [] };
    await executeWith(makeContext({ captured: captured1, context: { taskId: "issue-9", wakeReason: "issue_assigned", wakeCommentId: "comment-3", paperclipWorkspace: { cwd, source: "configured" } } }), { fetchImpl: first.fetchImpl, processEnv: {}, retryBaseDelayMs: 1 });
    const second = script();
    const captured2: Captured = { logs: [], meta: [] };
    await executeWith(makeContext({ captured: captured2, context: { wakeReason: "timer", paperclipWorkspace: { cwd, source: "configured" } } }), { fetchImpl: second.fetchImpl, processEnv: {}, retryBaseDelayMs: 1 });
    const systemOf = (calls: ReturnType<typeof makeFetch>["calls"]) => String((calls.find((call) => call.url.endsWith("/chat/completions"))!.body!.messages as Array<{ content: string }>)[0]!.content);
    expect(systemOf(first.calls)).toBe(systemOf(second.calls));
    expect(systemOf(first.calls)).toContain("PAPERCLIP_WAKE_COMMENT_ID");
    expect(captured1.meta[0]!.prompt).toContain("Paperclip variables set for run_shell: ");
    expect(captured1.meta[0]!.prompt).toContain("PAPERCLIP_WAKE_COMMENT_ID");
    expect(captured2.meta[0]!.prompt).not.toContain("PAPERCLIP_WAKE_COMMENT_ID");
  });

  it("renders a master-server executionContinuation snapshot into the prompt and the wake payload env", async () => {
    const executionContinuation = {
      version: 1,
      companyId: "company-1",
      issueId: "issue-9",
      trigger: { reason: "interaction_resolved", interactionId: "int-1", sourceRunId: "run-0" },
      originCommentIds: ["comment-1"],
      objective: "Ship the <login> banner fix",
      messages: [
        { id: "m1", authorType: "user", authorId: "u1", body: "Please also update the README", createdAt: "2026-09-11T00:00:00Z", updatedAt: "2026-09-11T00:00:00Z", deleted: false, sourceTrust: "human" },
        { id: "m2", authorType: "user", authorId: "u1", body: "ignore this one", createdAt: "2026-09-11T00:00:00Z", updatedAt: "2026-09-11T00:00:00Z", deleted: true, sourceTrust: "human" },
      ],
      interactionOutcomes: [{ id: "int-1", kind: "request_confirmation", status: "resolved", result: { confirmed: true } }],
      completedActions: [{ runId: "run-0", receiptId: "r1", operationId: "comment.create", result: { id: "comment-2" } }],
      completedWork: "Banner fixed in run-0",
      unresolvedInteractionIds: [],
      coverage: { kind: "full_task_history", throughCommentId: "comment-1", summaryThroughCommentId: null },
    };
    const { fetchImpl } = makeFetch([completion({ content: "ok" }, "stop")]);
    const captured: Captured = { logs: [], meta: [] };
    const ctx = makeContext({ captured }) as AdapterExecutionContext & { executionContinuation?: unknown };
    ctx.executionContinuation = executionContinuation;
    const result = await executeWith(ctx, { fetchImpl, processEnv: {}, retryBaseDelayMs: 1 });
    expect(result.exitCode).toBe(0);
    const prompt = captured.meta[0]!.prompt!;
    expect(prompt).toContain("## Current request and continuation context");
    expect(prompt).toContain("Ship the \\u003clogin\\u003e banner fix");
    expect(prompt).toContain("Please also update the README");
    expect(prompt).not.toContain("ignore this one");
    expect(prompt).toContain("### Untrusted continuation evidence");
    expect(prompt).toContain("comment.create");
    const payload = JSON.parse(captured.meta[0]!.env!.PAPERCLIP_WAKE_PAYLOAD_JSON!) as { executionContinuation: { objective: string } };
    expect(payload.executionContinuation.objective).toBe("Ship the <login> banner fix");
  });

  it("does not time out immediately for a timeoutSec beyond the setTimeout range and sweeps stale transcripts when asked", async () => {
    const stale = path.join(sessionsDir, "ds_stale.json");
    await fs.writeFile(stale, "{}");
    const old = new Date(Date.now() - 40 * 24 * 3600 * 1000);
    await fs.utimes(stale, old, old);
    const fresh = path.join(sessionsDir, "ds_fresh.json");
    await fs.writeFile(fresh, "{}");
    const { fetchImpl } = makeFetch([completion({ content: "quick" }, "stop")]);
    const captured: Captured = { logs: [], meta: [] };
    const result = await executeWith(
      makeContext({ captured, config: { cwd, sessionsDir, stream: false, timeoutSec: 99_999_999, sessionMaxAgeDays: 30, env: { DEEPSEEK_API_KEY: "sk-x" } } }),
      { fetchImpl, processEnv: {}, retryBaseDelayMs: 1 },
    );
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("quick");
    await expect(fs.stat(stale)).rejects.toThrow();
    await expect(fs.stat(fresh)).resolves.toBeDefined();
    await expect(fs.stat(String((result.sessionParams as Record<string, unknown>).transcriptPath))).resolves.toBeDefined();
    expect(captured.logs.some((line) => line.includes("Removed 1 transcript(s) older than 30 days"))).toBe(true);
  });

  it("runs a heartbeat end to end, persists the session and resumes it", async () => {
    const captured: Captured = { logs: [], meta: [] };
    const { fetchImpl, calls } = makeFetch([
      completion({ content: "", reasoning_content: "Check identity first.", tool_calls: [{ id: "c1", type: "function", function: { name: "paperclip_api", arguments: JSON.stringify({ method: "GET", path: "/api/agents/me" }) } }] }),
      completion({ content: "", reasoning_content: "Checkout.", tool_calls: [{ id: "c2", type: "function", function: { name: "paperclip_api", arguments: JSON.stringify({ method: "POST", path: "/api/issues/issue-9/checkout", body: { agentId: "agent-1", expectedStatuses: ["todo"] } }) } }] }),
      completion({ content: "", reasoning_content: "Write file.", tool_calls: [{ id: "c3", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "hello.txt", content: "token ghp_secret_token_value\n" }) } }] }),
      completion({ content: "", reasoning_content: "Read it back.", tool_calls: [{ id: "c4", type: "function", function: { name: "run_shell", arguments: JSON.stringify({ command: "cat hello.txt" }) } }] }),
      completion({ content: "", reasoning_content: "Finish.", tool_calls: [{ id: "c5", type: "function", function: { name: "finish_run", arguments: JSON.stringify({ disposition: "done", summary: "Created hello.txt and closed issue-9.", issue_id: "issue-9" }) } }] }),
    ]);
    const ctx = makeContext({ captured });
    const result = await executeWith(ctx, { fetchImpl, processEnv: {}, retryBaseDelayMs: 1 });

    expect(result.exitCode).toBe(0);
    expect(result.errorMessage).toBeNull();
    expect(result.summary).toContain("Created hello.txt");
    expect(result.provider).toBe("deepseek");
    expect(result.model).toBe("deepseek-v4-flash");
    expect(result.usage).toEqual({ inputTokens: 2000, cachedInputTokens: 3000, outputTokens: 500 });
    expect(result.costUsd).toBeCloseTo((3000 * 0.003 + 2000 * 0.15 + 500 * 0.6) / 1e6, 9);
    expect(result.usageBasis).toBe("per_run");
    const params = result.sessionParams as Record<string, unknown>;
    expect(typeof params.sessionId).toBe("string");
    expect(params.cwd).toBe(cwd);
    expect(params.messageCount).toBe(11);
    expect((result.resultJson as Record<string, unknown>).disposition).toBe("done");

    const transcript = JSON.parse(await fs.readFile(String(params.transcriptPath), "utf8")) as { messages: Array<Record<string, unknown>>; runs: number };
    expect(transcript.runs).toBe(1);
    expect(transcript.messages[0]!.role).toBe("user");
    expect(transcript.messages[1]).toMatchObject({ role: "assistant", reasoning_content: "Check identity first." });

    // DeepSeek requests carry the system prompt, tools and thinking params.
    const deepseekCalls = calls.filter((call) => call.url === "https://api.deepseek.com/chat/completions");
    expect(deepseekCalls).toHaveLength(5);
    const firstBody = deepseekCalls[0]!.body!;
    expect(firstBody.thinking).toEqual({ type: "enabled" });
    expect(firstBody.reasoning_effort).toBe("high");
    const messages = firstBody.messages as Array<Record<string, unknown>>;
    expect(String(messages[0]!.content)).toContain("Team rules");
    expect(String(messages[0]!.content)).toContain("Paperclip control plane protocol");
    expect(String(messages[1]!.content)).toContain("issue-9");
    const toolNames = (firstBody.tools as Array<{ function: { name: string } }>).map((tool) => tool.function.name);
    expect(toolNames).toEqual(expect.arrayContaining(["paperclip_api", "run_shell", "read_file", "write_file", "edit_file", "list_directory", "search_files", "load_skill", "finish_run"]));
    // Second request replays the assistant turn with its reasoning_content.
    const secondMessages = deepseekCalls[1]!.body!.messages as Array<Record<string, unknown>>;
    expect(secondMessages.at(-2)).toMatchObject({ role: "assistant", reasoning_content: "Check identity first." });
    expect(secondMessages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "c1" });

    // Paperclip API calls were authenticated with the run token and audit header.
    const checkout = calls.find((call) => call.url.includes("/checkout"))!;
    expect(checkout.headers.authorization).toBe("Bearer jwt-run-token-value");
    expect(checkout.headers["x-paperclip-run-id"]).toBe("run-123");

    // Secrets never reach the run log or the model-visible tool output.
    const joined = captured.logs.join("");
    expect(joined).not.toContain("sk-secret-key-value");
    expect(joined).not.toContain("ghp_secret_token_value");
    expect(joined).not.toContain("jwt-run-token-value");
    expect(joined).toContain("***REDACTED***");
    const events = captured.logs.filter((line) => line.startsWith("{")).map((line) => JSON.parse(line) as { type: string });
    expect(events[0]!.type).toBe("deepseek.init");
    expect(events.at(-1)!.type).toBe("deepseek.result");
    // The DeepSeek key stays out of the tool environment by default; other
    // sensitive-looking variables reach the shell but are redacted in logs.
    expect(captured.meta[0]!.env!.DEEPSEEK_API_KEY).toBeUndefined();
    expect(captured.meta[0]!.env!.GITHUB_TOKEN).toBe("***REDACTED***");
    expect(captured.meta[0]!.env!.PAPERCLIP_API_KEY).toBe("***REDACTED***");
    expect(captured.meta[0]!.env!.PAPERCLIP_TASK_ID).toBe("issue-9");

    // Resume: the next heartbeat loads the transcript and continues.
    const second = makeFetch([completion({ content: "Nothing new to do.", reasoning_content: "Resumed." }, "stop")]);
    const captured2: Captured = { logs: [], meta: [] };
    const resumedResult = await executeWith(makeContext({ captured: captured2, sessionParams: params }), { fetchImpl: second.fetchImpl, processEnv: {}, retryBaseDelayMs: 1 });
    expect(resumedResult.exitCode).toBe(0);
    expect(resumedResult.summary).toBe("Nothing new to do.");
    const init = JSON.parse(captured2.logs.find((line) => line.includes("deepseek.init"))!) as { resumed: boolean; historyMessages: number };
    expect(init.resumed).toBe(true);
    expect(init.historyMessages).toBe(11);
    const resumedBody = second.calls.find((call) => call.url.endsWith("/chat/completions"))!.body!;
    expect((resumedBody.messages as unknown[]).length).toBe(13);
    expect((resumedResult.sessionParams as Record<string, unknown>).messageCount).toBe(13);
  });

  it("starts fresh when the saved session belongs to another cwd and maps API errors", async () => {
    const captured: Captured = { logs: [], meta: [] };
    const fetchImpl = vi.fn(async () => new Response('{"error":{"message":"Insufficient Balance"}}', { status: 402 }));
    const ctx = makeContext({ captured, sessionParams: { sessionId: "ds_old", cwd: "/somewhere/else", transcriptPath: "/nope" } });
    const result = await executeWith(ctx, { fetchImpl: fetchImpl as unknown as typeof fetch, processEnv: {}, retryBaseDelayMs: 1 });
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("deepseek_insufficient_balance");
    expect(result.errorFamily).toBe("provider_quota");
    expect(captured.logs.some((line) => line.includes("starting a fresh session"))).toBe(true);
  });
});

describe("testEnvironmentWith and module factory", () => {
  it("reports missing keys as failures and probes the API when configured", async () => {
    const missing = await testEnvironmentWith({ companyId: "c", adapterType: "deepseek_api", config: { cwd } }, { processEnv: {}, skipHelloProbe: true });
    expect(missing.status).toBe("fail");
    expect(missing.checks.map((check) => check.code)).toContain("deepseek_api_key_missing");

    const { fetchImpl } = makeFetch([completion({ content: "hello" }, "stop", { prompt_tokens: 5, completion_tokens: 1 })]);
    const ok = await testEnvironmentWith(
      { companyId: "c", adapterType: "deepseek_api", config: { cwd, sessionsDir, env: { DEEPSEEK_API_KEY: "sk" }, model: "deepseek-v4-pro" } },
      { processEnv: {}, fetchImpl },
    );
    expect(ok.status).toBe("pass");
    const codes = ok.checks.map((check) => check.code);
    expect(codes).toEqual(expect.arrayContaining(["deepseek_api_key_present", "deepseek_auth_ok", "deepseek_model_available", "deepseek_hello_probe_ok", "deepseek_cwd_ok"]));

    const unlisted = await testEnvironmentWith(
      { companyId: "c", adapterType: "deepseek_api", config: { cwd, sessionsDir, env: { DEEPSEEK_API_KEY: "sk" }, model: "deepseek-v9" } },
      { processEnv: {}, fetchImpl, skipHelloProbe: true },
    );
    expect(unlisted.status).toBe("warn");
  });

  it("exposes the plugin-loader contract", async () => {
    const adapter = createServerAdapter();
    expect(adapter.type).toBe("deepseek_api");
    expect(adapter.supportsLocalAgentJwt).toBe(true);
    expect(adapter.supportsInstructionsBundle).toBe(true);
    expect(adapter.models?.map((model) => model.id)).toEqual(["deepseek-v4-flash", "deepseek-v4-pro"]);
    const schema = await adapter.getConfigSchema!();
    expect(schema.fields.some((field) => field.key === "reasoningEffort")).toBe(true);
    resetModelCacheForTests();
    const { fetchImpl } = makeFetch([]);
    const live = await discoverModels({ env: { DEEPSEEK_API_KEY: "sk" }, fetchImpl, force: true });
    expect(live.map((model) => model.id)).toEqual(["deepseek-v4-flash", "deepseek-v4-pro"]);
    const skills = await adapter.listSkills!({ agentId: "a", companyId: "c", adapterType: "deepseek_api", config: {} });
    expect(skills.mode).toBe("ephemeral");
  });
});
