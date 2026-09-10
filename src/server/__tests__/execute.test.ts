import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext, AdapterInvocationMeta } from "@paperclipai/adapter-utils";
import { executeWith } from "../execute.js";
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
  it("fails fast without an API key", async () => {
    const captured: Captured = { logs: [], meta: [] };
    const ctx = makeContext({ captured, config: { cwd, sessionsDir } });
    const result = await executeWith(ctx, { processEnv: {}, retryBaseDelayMs: 1 });
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("deepseek_api_key_missing");
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
