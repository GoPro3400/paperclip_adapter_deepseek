/**
 * Integration tests for the MCP bridge, runtime connection tools, context
 * compaction, secret redaction, shell edge cases and disabled tools.
 *
 * Everything runs through the real adapter entry point (executeWith) against
 * real node:http servers on ephemeral 127.0.0.1 ports: a non-streaming fake
 * DeepSeek API whose turns are scripted per request, a fake Streamable HTTP MCP
 * server and a fake runtime-tools REST server. No fetch mocking.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AdapterExecutionResult, AdapterInvocationMeta, AdapterRuntimeMcpServer } from "@paperclipai/adapter-utils";
import type { ExtendedExecutionContext, RuntimeToolAccess } from "../../compat.js";
import type { DeepSeekRunEvent } from "../../events.js";
import { executeWith } from "../../execute.js";
import { TRUNCATION_MARKER } from "../../text.js";
import { TOOL_NAME_PATTERN } from "../../tools/registry.js";
import {
  FakeDeepSeekJsonServer,
  FakeMcpServer,
  FakeRuntimeToolsServer,
  callsTurn,
  completionBody,
  finishTurn,
  messagesOfRequest,
  toolDefinitionOfRequest,
  toolNamesOfRequest,
  type FakeMcpServerOptions,
  type RecordedHttpRequest,
} from "./fake-servers-mcp.js";

const API_KEY = "sk-fake-deepseek-key-for-mcp-tests";
const RUN_TOKEN = "jwt-fake-paperclip-run-token-mcp";
const MCP_TOKEN = "mcp-bearer-token-0123456789abcdef";
const RUNTIME_TOKEN = "runtime-tools-bearer-token-fedcba9876543210";
const GITHUB_TOKEN = "ghp_integrationSecretValue0123456789";

let deepseek: FakeDeepSeekJsonServer;
let cwd: string;
let sessionsDir: string;
const extraServers: Array<{ close: () => Promise<void> }> = [];

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

function toolResultFor(captured: Captured, toolCallId: string): Extract<DeepSeekRunEvent, { type: "deepseek.tool_result" }> {
  const found = eventsOfType(captured, "deepseek.tool_result").find((event) => event.toolCallId === toolCallId);
  if (!found) throw new Error(`no deepseek.tool_result for ${toolCallId}; events: ${eventsOf(captured).map((event) => event.type).join(",")}`);
  return found;
}

function parsedToolResult(captured: Captured, toolCallId: string): Record<string, unknown> {
  return JSON.parse(toolResultFor(captured, toolCallId).output) as Record<string, unknown>;
}

function systemPromptOf(request: RecordedHttpRequest): string {
  const first = messagesOfRequest(request)[0];
  if (!first || first.role !== "system") throw new Error("first message is not the system prompt");
  return String(first.content);
}

function resultJson(result: AdapterExecutionResult): Record<string, unknown> {
  return (result.resultJson ?? {}) as Record<string, unknown>;
}

function baseConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    cwd,
    sessionsDir,
    model: "deepseek-v4-flash",
    baseUrl: deepseek.baseUrl,
    env: { DEEPSEEK_API_KEY: { type: "plain", value: API_KEY } },
    stream: false,
    reasoningEffort: "none",
    timeoutSec: 60,
    maxRetries: 0,
    graceSec: 1,
    ...overrides,
  };
}

function makeContext(input: {
  captured: Captured;
  config?: Record<string, unknown>;
  runId?: string;
  authToken?: string | null;
  sessionParams?: Record<string, unknown> | null;
  mcpServers?: AdapterRuntimeMcpServer[];
  runtimeTools?: RuntimeToolAccess;
  context?: Record<string, unknown>;
}): ExtendedExecutionContext {
  const ctx: ExtendedExecutionContext = {
    runId: input.runId ?? "run-mcp-1",
    agent: { id: "agent-1", companyId: "company-1", name: "DeepSeek Coder", adapterType: "deepseek_api", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: input.sessionParams ?? null, sessionDisplayId: null, taskKey: null },
    config: baseConfig(input.config),
    context: { taskId: "issue-7", wakeReason: "issue_assigned", paperclipWorkspace: { cwd, source: "configured" }, ...(input.context ?? {}) },
    onLog: async (_stream, chunk) => {
      input.captured.logs.push(chunk);
    },
    onMeta: async (meta) => {
      input.captured.meta.push(meta);
    },
  };
  if (input.authToken !== null) ctx.authToken = input.authToken ?? RUN_TOKEN;
  if (input.mcpServers) {
    const servers = input.mcpServers;
    ctx.runtimeMcp = { getServers: () => servers };
  }
  if (input.runtimeTools) ctx.runtimeTools = input.runtimeTools;
  return ctx;
}

async function run(ctx: ExtendedExecutionContext): Promise<AdapterExecutionResult> {
  return executeWith(ctx, { processEnv: {}, retryBaseDelayMs: 1 });
}

beforeEach(async () => {
  deepseek = await FakeDeepSeekJsonServer.start();
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), "deepseek-mcp-it-cwd-"));
  sessionsDir = await fs.mkdtemp(path.join(os.tmpdir(), "deepseek-mcp-it-sessions-"));
});

afterEach(async () => {
  await deepseek.close();
  for (const server of extraServers.splice(0)) await server.close();
  await fs.rm(cwd, { recursive: true, force: true });
  await fs.rm(sessionsDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. MCP bridge
// ---------------------------------------------------------------------------

const SEARCH_TOOL_NAME = "search docs.v1"; // space and dot are not valid in function names
const LONG_TOOL_NAME = "a".repeat(70); // longer than the 64-char function name limit
const SEARCH_SCHEMA = {
  type: "object",
  properties: {
    query: { type: "string", minLength: 1, description: "Full-text query" },
    limit: { type: "integer", minimum: 1, description: "Max results" },
  },
  required: ["query"],
  additionalProperties: false,
};
const LONG_SCHEMA = { type: "object", properties: { fail: { type: "boolean" } } };

async function startMcp(options: Partial<FakeMcpServerOptions> = {}): Promise<FakeMcpServer> {
  const server = await FakeMcpServer.start({
    token: options.token ?? MCP_TOKEN,
    tools: options.tools ?? [
      { name: SEARCH_TOOL_NAME, description: "Search the company docs", inputSchema: SEARCH_SCHEMA },
      { name: LONG_TOOL_NAME, description: "Long-named tool that fails on demand", inputSchema: LONG_SCHEMA },
    ],
    onCall:
      options.onCall ??
      ((name, args) => {
        if (name === SEARCH_TOOL_NAME) {
          return { content: [{ type: "text", text: `found 2 docs for "${String(args.query)}" (limit ${String(args.limit ?? "none")})` }] };
        }
        if (args.fail === true) return { content: [{ type: "text", text: "upstream exploded" }], isError: true };
        return { content: [{ type: "text", text: "ok" }] };
      }),
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    ...(options.protocolVersion ? { protocolVersion: options.protocolVersion } : {}),
    ...(options.sseFraming !== undefined ? { sseFraming: options.sseFraming } : {}),
    ...(options.failInitialize !== undefined ? { failInitialize: options.failInitialize } : {}),
  });
  extraServers.push(server);
  return server;
}

function mcpServerEntry(server: FakeMcpServer, name: string, token = MCP_TOKEN): AdapterRuntimeMcpServer {
  return { name, url: `${server.baseUrl}/mcp`, token, connectionId: `conn-${name.toLowerCase().replace(/\s+/g, "-")}` };
}

describe("MCP bridge over Streamable HTTP", () => {
  it("lists tools, validates arguments locally, forwards valid calls with session headers and surfaces isError", async () => {
    const mcp = await startMcp({ sessionId: "sess-abc-123", protocolVersion: "2025-03-26" });
    const searchFn = "mcp_company_tools_search_docs_v1";
    const longFn = `mcp_company_tools_${LONG_TOOL_NAME}`.slice(0, 64);
    deepseek.enqueue(
      callsTurn([{ id: "c1", name: searchFn, args: { query: "paperclip", limit: 2 } }]),
      callsTurn([{ id: "c2", name: searchFn, args: { limit: "three" } }]), // missing query, wrong type
      callsTurn([{ id: "c3", name: longFn, args: { fail: true } }]),
      finishTurn("c4", "MCP checks done."),
    );
    const captured: Captured = { logs: [], meta: [] };
    const result = await run(makeContext({ captured, mcpServers: [mcpServerEntry(mcp, "Company Tools")] }));

    expect(result.exitCode).toBe(0);
    expect(resultJson(result).stopReason).toBe("finish_run");

    // Tool definitions sent to DeepSeek carry sanitised names and the MCP inputSchema verbatim.
    const first = deepseek.chatRequests[0]!;
    const names = toolNamesOfRequest(first);
    expect(names).toContain(searchFn);
    expect(names).toContain(longFn);
    expect(longFn).toHaveLength(64);
    for (const name of names) expect(name).toMatch(TOOL_NAME_PATTERN);
    const searchDef = toolDefinitionOfRequest(first, searchFn)!;
    expect(searchDef.parameters).toEqual(SEARCH_SCHEMA);
    expect(searchDef.description).toContain("[MCP: Company Tools]");
    expect(searchDef.description).toContain("Search the company docs");
    expect(toolDefinitionOfRequest(first, longFn)!.parameters).toEqual(LONG_SCHEMA);
    expect(captured.meta[0]!.commandNotes).toContain("Exposed 2 MCP tool(s) from 1 server(s).");

    // The MCP server saw the handshake, the bearer token and the session header on every later call.
    expect(mcp.rpcMethods).toEqual(["initialize", "notifications/initialized", "tools/list", "tools/call", "tools/call"]);
    for (const request of mcp.requests) {
      expect(request.headers.authorization).toBe(`Bearer ${MCP_TOKEN}`);
      expect(String(request.headers.accept)).toContain("text/event-stream");
      expect(String(request.headers.accept)).toContain("application/json");
    }
    const init = mcp.requests[0]!;
    expect((init.json!.params as Record<string, unknown>).protocolVersion).toBe("2025-06-18");
    expect(init.headers["mcp-session-id"]).toBeUndefined();
    for (const request of mcp.requests.slice(1)) {
      expect(request.headers["mcp-session-id"]).toBe("sess-abc-123");
      expect(request.headers["mcp-protocol-version"]).toBe("2025-03-26");
    }

    // Invalid arguments never reached the server; the valid ones did, under the original tool name.
    expect(mcp.toolCalls).toEqual([
      { name: SEARCH_TOOL_NAME, arguments: { query: "paperclip", limit: 2 } },
      { name: LONG_TOOL_NAME, arguments: { fail: true } },
    ]);

    const ok = toolResultFor(captured, "c1");
    expect(ok.isError).toBe(false);
    expect(ok.output).toContain('found 2 docs for "paperclip" (limit 2)');

    const invalid = toolResultFor(captured, "c2");
    expect(invalid.isError).toBe(true);
    expect(invalid.output).toContain(`Invalid arguments for ${searchFn}`);
    expect(invalid.output).toContain("query: is required");
    expect(invalid.output).toContain("limit: expected integer, got string");
    const invalidPayload = JSON.parse(invalid.output) as Record<string, unknown>;
    expect(invalidPayload.expectedParameters).toEqual(SEARCH_SCHEMA);

    const failed = toolResultFor(captured, "c3");
    expect(failed.isError).toBe(true);
    expect(failed.output).toBe("upstream exploded");
    expect(resultJson(result).toolErrors).toBe(2);
    expect(resultJson(result).toolCalls).toBe(4);

    // The MCP bearer token is a secret: it must not show up in the run log or the logged env.
    expect(captured.logs.join("")).not.toContain(MCP_TOKEN);
    expect(JSON.stringify(captured.meta)).not.toContain(MCP_TOKEN);
  });

  it("parses text/event-stream framed responses and keeps running when another server fails initialize", async () => {
    const broken = await startMcp({ failInitialize: "rpc_error", tools: [{ name: "never", inputSchema: { type: "object" } }] });
    const streamy = await startMcp({
      sseFraming: true,
      sessionId: "sse-session-9",
      tools: [{ name: "ping", description: "Replies pong", inputSchema: { type: "object", properties: {}, additionalProperties: false } }],
      onCall: () => ({ content: [{ type: "text", text: "pong" }, { type: "image", data: "...", mimeType: "image/png" }] }),
    });
    deepseek.enqueue(callsTurn([{ id: "c1", name: "mcp_streamy_ping", args: {} }]), finishTurn("c2", "pinged"));
    const captured: Captured = { logs: [], meta: [] };
    const result = await run(
      makeContext({ captured, mcpServers: [mcpServerEntry(broken, "Broken"), mcpServerEntry(streamy, "Streamy")] }),
    );

    expect(result.exitCode).toBe(0);
    expect(resultJson(result).stopReason).toBe("finish_run");
    const warnings = eventsOfType(captured, "deepseek.warning").map((event) => event.message);
    expect(warnings.some((message) => message.includes('MCP server "Broken" unavailable') && message.includes("init rejected by fake server"))).toBe(true);
    expect(broken.rpcMethods).toEqual(["initialize"]);

    const names = toolNamesOfRequest(deepseek.chatRequests[0]!);
    expect(names).toContain("mcp_streamy_ping");
    expect(names.some((name) => name.startsWith("mcp_broken"))).toBe(false);
    expect(names).toContain("finish_run");

    expect(streamy.rpcMethods).toEqual(["initialize", "notifications/initialized", "tools/list", "tools/call"]);
    for (const request of streamy.requests.slice(1)) expect(request.headers["mcp-session-id"]).toBe("sse-session-9");
    const ping = toolResultFor(captured, "c1");
    expect(ping.isError).toBe(false);
    expect(ping.output).toBe("pong\n[image]");
  });

  it("does not exercise a server that fails initialize with HTTP 500 beyond a warning, and skips MCP entirely when mcpEnabled is false", async () => {
    const http500 = await startMcp({ failInitialize: "http_500" });
    deepseek.enqueue(finishTurn("c1", "nothing to do"));
    const captured: Captured = { logs: [], meta: [] };
    const result = await run(makeContext({ captured, mcpServers: [mcpServerEntry(http500, "Flaky")] }));
    expect(result.exitCode).toBe(0);
    const warnings = eventsOfType(captured, "deepseek.warning").map((event) => event.message);
    expect(warnings.some((message) => message.includes('MCP server "Flaky" unavailable') && message.includes("HTTP 500"))).toBe(true);
    expect(toolNamesOfRequest(deepseek.chatRequests[0]!).some((name) => name.startsWith("mcp_"))).toBe(false);

    const disabled = await startMcp();
    deepseek.resetScript().enqueue(finishTurn("c1", "nothing to do"));
    const captured2: Captured = { logs: [], meta: [] };
    const result2 = await run(makeContext({ captured: captured2, runId: "run-mcp-2", config: { mcpEnabled: false }, mcpServers: [mcpServerEntry(disabled, "Ignored")] }));
    expect(result2.exitCode).toBe(0);
    expect(disabled.requests).toHaveLength(0);
    expect(toolNamesOfRequest(deepseek.chatRequests[1]!).some((name) => name.startsWith("mcp_"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. Runtime connection tools
// ---------------------------------------------------------------------------

describe("runtime connection tools", () => {
  it("calls the REST endpoints with the bearer token, exports PAPERCLIP_RUNTIME_TOOLS_* to run_shell and adds the guidance to the system prompt", async () => {
    const rest = await FakeRuntimeToolsServer.start(RUNTIME_TOKEN);
    extraServers.push(rest);
    const guidance = "Use connections_search before assuming access to GitHub. GUIDANCE-MARKER-7f3a";
    const runtimeTools: RuntimeToolAccess = {
      version: 1,
      guidance,
      mcpEndpoint: `${rest.baseUrl}/api/runtime/mcp`,
      rest: { connectionsSearch: rest.searchUrl, connectionRequest: rest.requestUrl },
      bearerToken: RUNTIME_TOKEN,
      expiresAt: "2026-09-11T12:00:00.000Z",
      tools: ["connections_search", "connection_request"],
    };
    deepseek.enqueue(
      callsTurn([{ id: "c1", name: "connections_search", args: { query: "github" } }]),
      callsTurn([{ id: "c2", name: "connection_request", args: { service: "github" } }]),
      callsTurn([{ id: "c3", name: "run_shell", args: { command: "env | grep PAPERCLIP_RUNTIME_TOOLS_AVAILABLE" } }]),
      callsTurn([{ id: "c4", name: "run_shell", args: { command: "env | grep PAPERCLIP_RUNTIME_TOOLS_ | sort" } }]),
      finishTurn("c5", "connection tools exercised"),
    );
    const captured: Captured = { logs: [], meta: [] };
    const result = await run(makeContext({ captured, runtimeTools }));
    expect(result.exitCode).toBe(0);
    expect(resultJson(result).stopReason).toBe("finish_run");

    // Tool definitions and system prompt.
    const first = deepseek.chatRequests[0]!;
    expect(toolNamesOfRequest(first)).toEqual(expect.arrayContaining(["connections_search", "connection_request", "run_shell", "finish_run"]));
    const systemPrompt = systemPromptOf(first);
    expect(systemPrompt).toContain("## Connection tools");
    expect(systemPrompt).toContain(guidance);
    expect(systemPrompt).toContain("PAPERCLIP_RUNTIME_TOOLS_AVAILABLE");

    // REST server saw the bearer token and JSON bodies.
    expect(rest.requests).toHaveLength(2);
    const [search, request] = rest.requests as [RecordedHttpRequest, RecordedHttpRequest];
    expect(search.path).toBe(FakeRuntimeToolsServer.SEARCH_PATH);
    expect(search.headers.authorization).toBe(`Bearer ${RUNTIME_TOKEN}`);
    expect(search.headers["content-type"]).toContain("application/json");
    expect(search.json).toEqual({ query: "github" });
    expect(request.path).toBe(FakeRuntimeToolsServer.REQUEST_PATH);
    expect(request.headers.authorization).toBe(`Bearer ${RUNTIME_TOKEN}`);
    expect(request.json).toEqual({ service: "github" });

    // Tool results relay the JSON responses.
    const searchResult = parsedToolResult(captured, "c1");
    expect(searchResult.ok).toBe(true);
    expect(searchResult.result).toMatchObject({ query: "github", results: [{ service: "github", state: "needs_user_action" }] });
    const requestResult = parsedToolResult(captured, "c2");
    expect(requestResult.ok).toBe(true);
    expect(requestResult.result).toMatchObject({ service: "github", status: "requested" });

    // run_shell environment.
    const envAvailable = parsedToolResult(captured, "c3");
    expect(envAvailable.exit_code).toBe(0);
    expect(String(envAvailable.stdout).trim()).toBe("PAPERCLIP_RUNTIME_TOOLS_AVAILABLE=connections_search,connection_request");
    const envAll = String(parsedToolResult(captured, "c4").stdout);
    expect(envAll).toContain(`PAPERCLIP_RUNTIME_TOOLS_CONNECTIONS_SEARCH_URL=${rest.searchUrl}`);
    expect(envAll).toContain(`PAPERCLIP_RUNTIME_TOOLS_CONNECTION_REQUEST_URL=${rest.requestUrl}`);
    expect(envAll).toContain(`PAPERCLIP_RUNTIME_TOOLS_MCP_URL=${rest.baseUrl}/api/runtime/mcp`);
    expect(envAll).toContain("PAPERCLIP_RUNTIME_TOOLS_EXPIRES_AT=2026-09-11T12:00:00.000Z");
    expect(envAll).toContain("PAPERCLIP_RUNTIME_TOOLS_GUIDANCE=Use connections_search");
    // The token is present in the shell env but redacted when echoed back.
    expect(envAll).toContain("PAPERCLIP_RUNTIME_TOOLS_TOKEN=***REDACTED***");
    expect(envAll).not.toContain(RUNTIME_TOKEN);

    // The bearer token is never logged in clear text.
    expect(captured.logs.join("")).not.toContain(RUNTIME_TOKEN);
    const metaEnv = captured.meta[0]!.env!;
    expect(metaEnv.PAPERCLIP_RUNTIME_TOOLS_AVAILABLE).toBe("connections_search,connection_request");
    expect(metaEnv.PAPERCLIP_RUNTIME_TOOLS_TOKEN).toBeDefined();
    expect(metaEnv.PAPERCLIP_RUNTIME_TOOLS_TOKEN).not.toBe(RUNTIME_TOKEN);
    expect(JSON.stringify(captured.meta)).not.toContain(RUNTIME_TOKEN);
  });

  it("omits the connection tools when connectionToolsEnabled is false", async () => {
    const rest = await FakeRuntimeToolsServer.start(RUNTIME_TOKEN);
    extraServers.push(rest);
    const runtimeTools: RuntimeToolAccess = {
      version: 1,
      guidance: "GUIDANCE-MARKER-off",
      mcpEndpoint: "",
      rest: { connectionsSearch: rest.searchUrl, connectionRequest: rest.requestUrl },
      bearerToken: RUNTIME_TOKEN,
      expiresAt: "",
      tools: ["connections_search", "connection_request"],
    };
    deepseek.enqueue(finishTurn("c1", "no tools"));
    const captured: Captured = { logs: [], meta: [] };
    const result = await run(makeContext({ captured, runtimeTools, config: { connectionToolsEnabled: false } }));
    expect(result.exitCode).toBe(0);
    const names = toolNamesOfRequest(deepseek.chatRequests[0]!);
    expect(names).not.toContain("connections_search");
    expect(names).not.toContain("connection_request");
    expect(systemPromptOf(deepseek.chatRequests[0]!)).not.toContain("GUIDANCE-MARKER-off");
    expect(rest.requests).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Context compaction
// ---------------------------------------------------------------------------

const SUMMARY_TEXT = "SUMMARY-MARKER: earlier heartbeats ran seed commands and finished; issue-7 is in progress.";

function isSummariserRequest(request: RecordedHttpRequest): boolean {
  const body = request.json ?? {};
  const thinking = body.thinking as { type?: string } | undefined;
  return thinking?.type === "disabled" && body.tools === undefined;
}

/** Answers summariser requests with SUMMARY_TEXT and everything else from `turns`, in order. */
function scriptWithSummariser(turns: Array<Record<string, unknown>>): (request: RecordedHttpRequest) => Record<string, unknown> {
  let index = 0;
  return (request) => {
    if (isSummariserRequest(request)) return completionBody({ content: SUMMARY_TEXT }, "stop", { prompt_tokens: 800, completion_tokens: 60 });
    const turn = turns[index] ?? turns[turns.length - 1]!;
    index += 1;
    return turn;
  };
}

/** A heartbeat with `shellTurns` run_shell echo turns followed by finish_run. */
function seedTurns(label: string, shellTurns: number): Array<Record<string, unknown>> {
  const turns: Array<Record<string, unknown>> = [];
  for (let step = 1; step <= shellTurns; step += 1) {
    turns.push(callsTurn([{ id: `${label}-s${step}`, name: "run_shell", args: { command: `echo ${label}-step-${step}` } }], { reasoning: `step ${step}` }));
  }
  turns.push(callsTurn([{ id: `${label}-finish`, name: "finish_run", args: { disposition: "in_progress", summary: `${label} finished` } }], { reasoning: "finish" }));
  return turns;
}

describe("context compaction", () => {
  it("compacts a transcript seeded by two earlier heartbeats: summary first, recent messages verbatim, transcript rewritten on disk", async () => {
    const compactionConfig = { reasoningEffort: "high" };
    // Heartbeat 1: 3 shell turns + finish -> 9 messages. Heartbeat 2: 1 shell turn + finish -> 5 more (14 total).
    deepseek.enqueue(...seedTurns("seed1", 3));
    const captured1: Captured = { logs: [], meta: [] };
    const result1 = await run(makeContext({ captured: captured1, runId: "run-seed-1", config: compactionConfig }));
    expect(result1.exitCode).toBe(0);
    expect(result1.sessionParams!.messageCount).toBe(9);

    deepseek.resetScript().enqueue(...seedTurns("seed2", 1));
    const captured2: Captured = { logs: [], meta: [] };
    const result2 = await run(makeContext({ captured: captured2, runId: "run-seed-2", sessionParams: result1.sessionParams, config: compactionConfig }));
    expect(result2.exitCode).toBe(0);
    expect(result2.sessionParams!.messageCount).toBe(14);
    const seed2UserPrompt = captured2.meta[0]!.prompt!;
    expect(seed2UserPrompt).toContain("run-seed-2");

    // Heartbeat 3 with a tiny threshold: compaction must run before the first model call.
    deepseek.resetScript().setFallback(scriptWithSummariser([finishTurn("c-final", "after compaction")]));
    const captured3: Captured = { logs: [], meta: [] };
    const result3 = await run(
      makeContext({
        captured: captured3,
        runId: "run-compact-3",
        sessionParams: result2.sessionParams,
        config: { ...compactionConfig, compactionThresholdTokens: 100, compactionKeepRecentMessages: 4 },
      }),
    );
    expect(result3.exitCode).toBe(0);
    expect(resultJson(result3).compactions).toBe(1);

    const statuses = eventsOfType(captured3, "deepseek.status").map((event) => event.message);
    expect(statuses.some((message) => message.startsWith("Compacting context: summarizing 9 earlier messages"))).toBe(true);

    const requests3 = deepseek.chatRequests.slice(-2);
    const [summariser, main] = requests3 as [RecordedHttpRequest, RecordedHttpRequest];
    expect(isSummariserRequest(summariser)).toBe(true);
    const summariserMessages = messagesOfRequest(summariser);
    expect(String(summariserMessages[0]!.content)).toContain("You compress an AI agent's working transcript");
    expect(String(summariserMessages[1]!.content)).toContain("Transcript to compress");
    expect(String(summariserMessages[1]!.content)).toContain("echo seed1-step-3");
    expect(String(summariserMessages[1]!.content)).not.toContain("seed2-step-1");
    expect(summariser.json!.stream).toBe(false);

    // Main request: system, summary user, ack assistant, then the 6 recent messages verbatim.
    expect(isSummariserRequest(main)).toBe(false);
    const mainMessages = messagesOfRequest(main);
    expect(mainMessages).toHaveLength(9);
    expect(mainMessages[0]!.role).toBe("system");
    expect(String(mainMessages[1]!.content).startsWith("[Context summary")).toBe(true);
    expect(String(mainMessages[1]!.content)).toContain(SUMMARY_TEXT);
    expect(mainMessages[1]!.role).toBe("user");
    expect(mainMessages[2]!.role).toBe("assistant");
    expect(mainMessages[3]).toMatchObject({ role: "user", content: seed2UserPrompt });
    expect(mainMessages[4]).toMatchObject({ role: "assistant" });
    expect(String((mainMessages[4]!.tool_calls as Array<{ function: { arguments: string } }>)[0]!.function.arguments)).toContain("seed2-step-1");
    expect(mainMessages[5]).toMatchObject({ role: "tool", tool_call_id: "seed2-s1" });
    expect(mainMessages[7]).toMatchObject({ role: "tool", tool_call_id: "seed2-finish" });
    expect(mainMessages[8]!.role).toBe("user");
    expect(String(mainMessages[8]!.content)).toContain("run-compact-3");
    expect(JSON.stringify(mainMessages)).not.toContain("seed1-step-1");

    // Transcript on disk is the compacted conversation plus this heartbeat's turn.
    const transcript = JSON.parse(await fs.readFile(String(result3.sessionParams!.transcriptPath), "utf8")) as { messages: Array<Record<string, unknown>>; runs: number };
    expect(transcript.runs).toBe(3);
    expect(transcript.messages).toHaveLength(10);
    expect(String(transcript.messages[0]!.content).startsWith("[Context summary")).toBe(true);
    expect(result3.sessionParams!.messageCount).toBe(10);
    expect(JSON.stringify(transcript.messages)).not.toContain("seed1-step-1");
  });

  it("compacts a transcript seeded by a single long heartbeat (history with one user turn)", async () => {
    // Heartbeat 1: 6 shell turns + finish -> 15 messages, only messages[0] has role user.
    deepseek.enqueue(...seedTurns("long", 6));
    const captured1: Captured = { logs: [], meta: [] };
    const result1 = await run(makeContext({ captured: captured1, runId: "run-long-1", config: { reasoningEffort: "high" } }));
    expect(result1.exitCode).toBe(0);
    expect(result1.sessionParams!.messageCount).toBe(15);

    deepseek.resetScript().setFallback(scriptWithSummariser([finishTurn("c-final", "after compaction")]));
    const captured2: Captured = { logs: [], meta: [] };
    const result2 = await run(
      makeContext({
        captured: captured2,
        runId: "run-long-2",
        sessionParams: result1.sessionParams,
        config: { reasoningEffort: "high", compactionThresholdTokens: 100, compactionKeepRecentMessages: 4 },
      }),
    );
    expect(result2.exitCode).toBe(0);

    // The last prompt (1100 tokens) exceeded the threshold (100), so the README contract says older
    // turns are summarised and the 4 most recent messages stay verbatim.
    const statuses = eventsOfType(captured2, "deepseek.status").map((event) => event.message);
    expect(statuses.some((message) => message.startsWith("Compacting context"))).toBe(true);
    expect(resultJson(result2).compactions).toBe(1);
    const summarisers = deepseek.chatRequests.filter(isSummariserRequest);
    expect(summarisers).toHaveLength(1);
    const main = deepseek.chatRequests[deepseek.chatRequests.length - 1]!;
    const mainMessages = messagesOfRequest(main);
    expect(String(mainMessages[1]!.content).startsWith("[Context summary")).toBe(true);
    expect(mainMessages.length).toBeLessThan(16);
    const transcript = JSON.parse(await fs.readFile(String(result2.sessionParams!.transcriptPath), "utf8")) as { messages: Array<Record<string, unknown>> };
    expect(transcript.messages.length).toBeLessThan(17);
  });
});

// ---------------------------------------------------------------------------
// 4. Secret redaction
// ---------------------------------------------------------------------------

describe("secret redaction", () => {
  it("redacts a configured token everywhere in the run log, meta env and tool results while leaving file contents intact", async () => {
    deepseek.enqueue(
      callsTurn([{ id: "c1", name: "run_shell", args: { command: "echo $GITHUB_TOKEN" } }]),
      callsTurn([{ id: "c2", name: "write_file", args: { path: "secret.txt", content: `token=${GITHUB_TOKEN}\n` } }]),
      callsTurn([{ id: "c3", name: "read_file", args: { path: "secret.txt" } }]),
      callsTurn([{ id: "c4", name: "run_shell", args: { command: "env | sort" } }]),
      callsTurn([{ id: "c5", name: "run_shell", args: { command: "cat secret.txt" } }], { content: `The token is ${GITHUB_TOKEN}` }),
      callsTurn([{ id: "c6", name: "finish_run", args: { disposition: "done", summary: `Echoed ${GITHUB_TOKEN} and finished.` } }]),
    );
    const captured: Captured = { logs: [], meta: [] };
    const result = await run(
      makeContext({
        captured,
        config: { env: { DEEPSEEK_API_KEY: { type: "plain", value: API_KEY }, GITHUB_TOKEN } },
      }),
    );
    expect(result.exitCode).toBe(0);
    expect(resultJson(result).stopReason).toBe("finish_run");

    // The file on disk carries the raw value: the adapter must not alter file contents.
    expect(await fs.readFile(path.join(cwd, "secret.txt"), "utf8")).toBe(`token=${GITHUB_TOKEN}\n`);

    // No log line, meta env entry or tool result exposes the raw values.
    for (const line of captured.logs) {
      expect(line).not.toContain(GITHUB_TOKEN);
      expect(line).not.toContain(API_KEY);
    }
    const metaEnv = captured.meta[0]!.env!;
    expect(metaEnv.GITHUB_TOKEN).toBeDefined();
    expect(metaEnv.GITHUB_TOKEN).not.toBe(GITHUB_TOKEN);
    for (const value of Object.values(metaEnv)) {
      expect(value).not.toContain(GITHUB_TOKEN);
      expect(value).not.toContain(API_KEY);
    }
    expect(metaEnv.DEEPSEEK_API_KEY).toBeUndefined();
    for (const event of eventsOfType(captured, "deepseek.tool_result")) {
      expect(event.output).not.toContain(GITHUB_TOKEN);
      expect(event.output).not.toContain(API_KEY);
    }

    const echo = parsedToolResult(captured, "c1");
    expect(echo.exit_code).toBe(0);
    expect(String(echo.stdout).trim()).toBe("***REDACTED***");
    const read = parsedToolResult(captured, "c3");
    expect(read.ok).toBe(true);
    expect(read.content).toBe("token=***REDACTED***\n");
    const cat = parsedToolResult(captured, "c5");
    expect(String(cat.stdout)).toBe("token=***REDACTED***\n");

    // `env` output: the token line is redacted and the DeepSeek key is not in the shell environment at all.
    const env = String(parsedToolResult(captured, "c4").stdout);
    expect(env).toContain("GITHUB_TOKEN=***REDACTED***");
    expect(env).not.toContain(API_KEY);
    expect(env).not.toMatch(/^DEEPSEEK_API_KEY=/m);
    expect(env).toContain("PAPERCLIP_RUN_ID=run-mcp-1");
    expect(env).toContain("PAPERCLIP_API_KEY=***REDACTED***");
    expect(env).not.toContain(RUN_TOKEN);

    // Assistant text and the final summary are redacted too.
    const assistantTexts = eventsOfType(captured, "deepseek.assistant").map((event) => event.text);
    expect(assistantTexts.some((text) => text.includes("The token is ***REDACTED***"))).toBe(true);
    expect(result.summary).toBe("Echoed ***REDACTED*** and finished.");
    expect(String(result.summary)).not.toContain(GITHUB_TOKEN);
    const resultEvent = eventsOfType(captured, "deepseek.result")[0]!;
    expect(resultEvent.summary).not.toContain(GITHUB_TOKEN);

    // Tool messages fed back to the model are the redacted ones.
    const last = deepseek.chatRequests[deepseek.chatRequests.length - 1]!;
    for (const message of messagesOfRequest(last)) {
      if (message.role === "tool") expect(String(message.content)).not.toContain(GITHUB_TOKEN);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Shell edge cases
// ---------------------------------------------------------------------------

describe("run_shell edge cases", () => {
  it("truncates oversized output with the marker keeping head and tail, kills background children on timeout, rejects a missing cwd and delivers stdin", async () => {
    const before = Date.now();
    deepseek.enqueue(
      callsTurn([{ id: "c1", name: "run_shell", args: { command: 'for i in $(seq 1 1200); do echo "line-$i"; done' } }]),
      callsTurn([{ id: "c2", name: "run_shell", args: { command: "sleep 30 & wait", timeout_sec: 1 } }]),
      callsTurn([{ id: "c3", name: "run_shell", args: { command: "pwd", cwd: "does-not-exist" } }]),
      callsTurn([{ id: "c4", name: "run_shell", args: { command: "cat", stdin: "hello from stdin\nsecond line" } }]),
      finishTurn("c5", "shell edge cases done"),
    );
    const captured: Captured = { logs: [], meta: [] };
    const result = await run(makeContext({ captured, config: { maxToolOutputChars: 4000, shellTimeoutSec: 5, graceSec: 1 } }));
    expect(result.exitCode).toBe(0);
    expect(resultJson(result).stopReason).toBe("finish_run");

    // 1200 lines (~10.9K chars) exceed the per-stream cap (max(2000, 4000/2) = 2000 chars).
    const big = toolResultFor(captured, "c1");
    expect(big.output.length).toBeLessThanOrEqual(4000);
    const bigPayload = JSON.parse(big.output) as Record<string, unknown>;
    expect(bigPayload.exit_code).toBe(0);
    expect(bigPayload.truncated).toBe(true);
    expect(String(bigPayload.note)).toContain("truncated");
    const stdout = String(bigPayload.stdout);
    expect(stdout).toContain(TRUNCATION_MARKER);
    expect(stdout).toMatch(/chars omitted/);
    expect(stdout.startsWith("line-1\nline-2\nline-3\n")).toBe(true);
    expect(stdout.endsWith("line-1199\nline-1200\n")).toBe(true);
    expect(stdout.length).toBeLessThanOrEqual(2000);

    // Background child: the whole process group is terminated within the timeout + grace.
    const timeout = toolResultFor(captured, "c2");
    expect(timeout.isError).toBe(true);
    const timeoutPayload = JSON.parse(timeout.output) as Record<string, unknown>;
    expect(timeoutPayload.timed_out).toBe(true);
    expect(timeoutPayload.ok).toBe(false);
    expect(String(timeoutPayload.error)).toContain("timed out after 1s");
    expect(Number(timeoutPayload.duration_ms)).toBeLessThan(5000);
    expect(timeout.durationMs).toBeLessThan(5000);

    // Missing cwd.
    const missing = toolResultFor(captured, "c3");
    expect(missing.isError).toBe(true);
    const missingPayload = JSON.parse(missing.output) as Record<string, unknown>;
    expect(missingPayload.ok).toBe(false);
    expect(String(missingPayload.error)).toContain("cwd does not exist");
    expect(String(missingPayload.error)).toContain(path.join(cwd, "does-not-exist"));

    // stdin delivery.
    const stdin = parsedToolResult(captured, "c4");
    expect(stdin.exit_code).toBe(0);
    expect(stdin.stdout).toBe("hello from stdin\nsecond line");

    // The whole run (including the 1s timeout) finished promptly: the killed tree did not hold the pipes open.
    expect(Date.now() - before).toBeLessThan(15_000);
  });

  it("keeps the head of very large output (beyond the capture buffer) as documented for head+tail truncation", async () => {
    // ~300K chars, far above 4 x maxToolOutputChars (the capture buffer).
    deepseek.enqueue(
      callsTurn([{ id: "c1", name: "run_shell", args: { command: 'for i in $(seq 1 30000); do echo "line-$i"; done' } }]),
      finishTurn("c2", "done"),
    );
    const captured: Captured = { logs: [], meta: [] };
    const result = await run(makeContext({ captured, config: { maxToolOutputChars: 4000 } }));
    expect(result.exitCode).toBe(0);
    const payload = parsedToolResult(captured, "c1");
    expect(payload.exit_code).toBe(0);
    expect(payload.truncated).toBe(true);
    const stdout = String(payload.stdout);
    expect(stdout).toContain(TRUNCATION_MARKER);
    expect(stdout.endsWith("line-30000\n")).toBe(true);
    expect(stdout.startsWith("line-1\nline-2\n")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. Disabled tools
// ---------------------------------------------------------------------------

describe("disabled tools", () => {
  it("removes run_shell and paperclip_api from the definitions but keeps finish_run, with the protocol prompt intact when a token is present", async () => {
    deepseek.enqueue(finishTurn("c1", "nothing to do"));
    const captured: Captured = { logs: [], meta: [] };
    const result = await run(makeContext({ captured, config: { disabledTools: ["run_shell", "paperclip_api", "finish_run"] } }));
    expect(result.exitCode).toBe(0);
    const first = deepseek.chatRequests[0]!;
    const names = toolNamesOfRequest(first);
    expect(names).not.toContain("run_shell");
    expect(names).not.toContain("paperclip_api");
    expect(names).toContain("finish_run"); // finish_run cannot be disabled
    expect(names).toEqual(expect.arrayContaining(["read_file", "write_file", "edit_file", "list_directory", "search_files"]));
    const initEvent = eventsOfType(captured, "deepseek.init")[0]!;
    expect(initEvent.toolNames).toEqual(names);
    expect(captured.meta[0]!.commandNotes).toEqual(
      expect.arrayContaining(["Tool run_shell disabled by configuration.", "Tool paperclip_api disabled by configuration."]),
    );
    // A run token was issued, so the prompt must not claim the API tool is unavailable.
    const systemPrompt = systemPromptOf(first);
    expect(systemPrompt).not.toContain("the `paperclip_api` tool is unavailable");
    expect(systemPrompt).toContain("## Paperclip control plane protocol");
    expect(systemPrompt).not.toContain("`run_shell`,");
    expect(systemPrompt).not.toMatch(/Paperclip control plane: .*`paperclip_api`/);
  });

  it("says the Paperclip API tool is unavailable only when no run token is given", async () => {
    deepseek.enqueue(finishTurn("c1", "nothing to do"));
    const captured: Captured = { logs: [], meta: [] };
    const result = await run(makeContext({ captured, authToken: null, config: { disabledTools: ["run_shell"] } }));
    expect(result.exitCode).toBe(0);
    const first = deepseek.chatRequests[0]!;
    const names = toolNamesOfRequest(first);
    expect(names).not.toContain("paperclip_api");
    expect(names).not.toContain("run_shell");
    expect(names).toContain("finish_run");
    const systemPrompt = systemPromptOf(first);
    expect(systemPrompt).toContain("No Paperclip API credential was issued for this run, so the `paperclip_api` tool is unavailable.");
    expect(systemPrompt).not.toContain("## Paperclip control plane protocol");
    expect(captured.meta[0]!.commandNotes).toContain("Paperclip API tool unavailable: no run token or API URL was provided.");
    expect(captured.meta[0]!.env!.PAPERCLIP_API_KEY).toBeUndefined();
  });
});
