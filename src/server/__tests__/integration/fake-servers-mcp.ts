/**
 * Real node:http servers for the MCP / runtime-tools / edge-case integration
 * tests (see mcp-and-edge-cases.integration.test.ts).
 *
 * - FakeMcpServer: a Streamable HTTP MCP server (single POST endpoint, JSON-RPC
 *   2.0). Implements initialize (issues Mcp-Session-Id), notifications/initialized
 *   (202, empty body), tools/list and tools/call. Can answer with plain JSON or
 *   with text/event-stream framing, can reject initialize, and enforces the bearer
 *   token and the session header so a client that forgets them fails loudly.
 * - FakeRuntimeToolsServer: the two REST endpoints behind Paperclip's runtime
 *   connection tools (connections_search / connection_request).
 * - FakeDeepSeekJsonServer: a non-streaming OpenAI-compatible chat completions
 *   endpoint whose responses are scripted per request.
 *
 * All servers listen on 127.0.0.1 with an ephemeral port and record every
 * request (headers + parsed body).
 */
import http from "node:http";
import type { AddressInfo, Socket } from "node:net";

export interface RecordedHttpRequest {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: string;
  json: Record<string, unknown> | null;
  /** JSON-RPC method for MCP requests (null otherwise). */
  rpcMethod: string | null;
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const parts: Buffer[] = [];
  for await (const chunk of req) parts.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(parts).toString("utf8");
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  if (!text.trim()) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

abstract class RecordingHttpServer {
  readonly requests: RecordedHttpRequest[] = [];
  readonly baseUrl: string;
  protected readonly server: http.Server;
  private readonly sockets = new Set<Socket>();

  protected constructor(server: http.Server) {
    this.server = server;
    const address = server.address() as AddressInfo;
    this.baseUrl = `http://127.0.0.1:${address.port}`;
    server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
    });
  }

  protected static listen(handler: http.RequestListener): Promise<http.Server> {
    return new Promise((resolve, reject) => {
      const server = http.createServer(handler);
      server.keepAliveTimeout = 1000;
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve(server));
    });
  }

  protected async record(req: http.IncomingMessage): Promise<RecordedHttpRequest> {
    const body = await readBody(req);
    const json = parseJsonObject(body);
    const recorded: RecordedHttpRequest = {
      method: req.method ?? "GET",
      path: (req.url ?? "/").split("?")[0]!,
      headers: req.headers,
      body,
      json,
      rpcMethod: json && typeof json.method === "string" ? json.method : null,
    };
    this.requests.push(recorded);
    return recorded;
  }

  protected sendJson(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    const payload = body === undefined ? "" : JSON.stringify(body);
    res.writeHead(status, {
      ...(payload ? { "content-type": "application/json" } : {}),
      "content-length": Buffer.byteLength(payload),
      ...headers,
    });
    res.end(payload);
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

// ---------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------

export interface McpToolSpec {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface McpCallResult {
  content: Array<Record<string, unknown>>;
  isError?: boolean;
  structuredContent?: unknown;
}

export interface FakeMcpServerOptions {
  /** Bearer token the server insists on (401 otherwise). */
  token: string;
  sessionId?: string;
  protocolVersion?: string;
  tools: McpToolSpec[];
  onCall?: (name: string, args: Record<string, unknown>) => McpCallResult;
  /** Answer every POST with `text/event-stream` framing instead of plain JSON. */
  sseFraming?: boolean;
  /** How initialize should fail, if at all. */
  failInitialize?: "rpc_error" | "http_500" | null;
}

export class FakeMcpServer extends RecordingHttpServer {
  readonly options: {
    token: string;
    sessionId: string;
    protocolVersion: string;
    tools: McpToolSpec[];
    sseFraming: boolean;
    onCall: FakeMcpServerOptions["onCall"];
    failInitialize: FakeMcpServerOptions["failInitialize"];
  };

  static async start(options: FakeMcpServerOptions): Promise<FakeMcpServer> {
    let instance: FakeMcpServer | null = null;
    const server = await RecordingHttpServer.listen((req, res) => {
      void instance!.handle(req, res);
    });
    instance = new FakeMcpServer(server, options);
    return instance;
  }

  private constructor(server: http.Server, options: FakeMcpServerOptions) {
    super(server);
    this.options = {
      token: options.token,
      sessionId: options.sessionId ?? "mcp-session-0001",
      protocolVersion: options.protocolVersion ?? "2025-03-26",
      tools: options.tools,
      sseFraming: options.sseFraming ?? false,
      onCall: options.onCall,
      failInitialize: options.failInitialize ?? null,
    };
  }

  get rpcMethods(): string[] {
    return this.requests.map((request) => request.rpcMethod ?? `<${request.method} ${request.path}>`);
  }

  get toolCalls(): Array<{ name: string; arguments: Record<string, unknown> }> {
    return this.requests
      .filter((request) => request.rpcMethod === "tools/call")
      .map((request) => {
        const params = (request.json?.params ?? {}) as Record<string, unknown>;
        return { name: String(params.name), arguments: (params.arguments ?? {}) as Record<string, unknown> };
      });
  }

  private respondRpc(res: http.ServerResponse, payload: Record<string, unknown>, extraHeaders: Record<string, string> = {}): void {
    if (this.options.sseFraming) {
      const body = `event: message\nid: ${Date.now()}\ndata: ${JSON.stringify(payload)}\n\n`;
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "content-length": Buffer.byteLength(body), ...extraHeaders });
      res.end(body);
      return;
    }
    this.sendJson(res, 200, payload, extraHeaders);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const recorded = await this.record(req);
    if (recorded.method !== "POST") {
      this.sendJson(res, 405, { error: "only POST is supported" });
      return;
    }
    if (recorded.headers.authorization !== `Bearer ${this.options.token}`) {
      this.sendJson(res, 401, { error: "bad or missing bearer token" });
      return;
    }
    const rpc = recorded.json;
    if (!rpc || rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string") {
      this.sendJson(res, 400, { error: "not a JSON-RPC 2.0 request" });
      return;
    }
    const id = rpc.id ?? null;
    const params = (rpc.params ?? {}) as Record<string, unknown>;

    if (rpc.method === "initialize") {
      if (this.options.failInitialize === "http_500") {
        this.sendJson(res, 500, { error: "mcp backend down" });
        return;
      }
      if (this.options.failInitialize === "rpc_error") {
        this.respondRpc(res, { jsonrpc: "2.0", id, error: { code: -32000, message: "init rejected by fake server" } });
        return;
      }
      this.respondRpc(
        res,
        {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: this.options.protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "fake-mcp", version: "0.0.1" },
          },
        },
        { "Mcp-Session-Id": this.options.sessionId },
      );
      return;
    }

    // Everything after initialize must carry the session the server issued.
    if (recorded.headers["mcp-session-id"] !== this.options.sessionId) {
      this.sendJson(res, 400, { error: "missing or unknown Mcp-Session-Id" });
      return;
    }

    if (rpc.method === "notifications/initialized") {
      res.writeHead(202, { "content-length": 0 });
      res.end();
      return;
    }
    if (rpc.method === "tools/list") {
      this.respondRpc(res, {
        jsonrpc: "2.0",
        id,
        result: { tools: this.options.tools.map((tool) => ({ name: tool.name, description: tool.description ?? "", inputSchema: tool.inputSchema })) },
      });
      return;
    }
    if (rpc.method === "tools/call") {
      const name = String(params.name ?? "");
      const known = this.options.tools.some((tool) => tool.name === name);
      if (!known) {
        this.respondRpc(res, { jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown tool: ${name}` } });
        return;
      }
      const result: McpCallResult = this.options.onCall
        ? this.options.onCall(name, (params.arguments ?? {}) as Record<string, unknown>)
        : { content: [{ type: "text", text: `called ${name}` }] };
      this.respondRpc(res, { jsonrpc: "2.0", id, result });
      return;
    }
    this.respondRpc(res, { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${rpc.method}` } });
  }
}

// ---------------------------------------------------------------------------
// Runtime connection tools REST endpoints
// ---------------------------------------------------------------------------

export class FakeRuntimeToolsServer extends RecordingHttpServer {
  static readonly SEARCH_PATH = "/api/runtime/connections/search";
  static readonly REQUEST_PATH = "/api/runtime/connections/request";

  static async start(token: string): Promise<FakeRuntimeToolsServer> {
    let instance: FakeRuntimeToolsServer | null = null;
    const server = await RecordingHttpServer.listen((req, res) => {
      void instance!.handle(req, res);
    });
    instance = new FakeRuntimeToolsServer(server, token);
    return instance;
  }

  private constructor(server: http.Server, private readonly token: string) {
    super(server);
  }

  get searchUrl(): string {
    return `${this.baseUrl}${FakeRuntimeToolsServer.SEARCH_PATH}`;
  }

  get requestUrl(): string {
    return `${this.baseUrl}${FakeRuntimeToolsServer.REQUEST_PATH}`;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const recorded = await this.record(req);
    if (recorded.headers.authorization !== `Bearer ${this.token}`) {
      this.sendJson(res, 401, { error: "bad or missing bearer token" });
      return;
    }
    if (recorded.method === "POST" && recorded.path === FakeRuntimeToolsServer.SEARCH_PATH) {
      const query = String(recorded.json?.query ?? "");
      this.sendJson(res, 200, {
        query,
        results: [{ service: "github", label: "GitHub", state: "needs_user_action" }],
      });
      return;
    }
    if (recorded.method === "POST" && recorded.path === FakeRuntimeToolsServer.REQUEST_PATH) {
      this.sendJson(res, 200, { service: recorded.json?.service ?? null, status: "requested", requestId: "connreq-1" });
      return;
    }
    this.sendJson(res, 404, { error: `unknown route ${recorded.method} ${recorded.path}` });
  }
}

// ---------------------------------------------------------------------------
// Non-streaming DeepSeek chat completions
// ---------------------------------------------------------------------------

export const JSON_USAGE = {
  prompt_tokens: 1000,
  completion_tokens: 100,
  prompt_cache_hit_tokens: 600,
  prompt_cache_miss_tokens: 400,
  prompt_tokens_details: { cached_tokens: 600 },
  completion_tokens_details: { reasoning_tokens: 10 },
};

export interface ScriptedToolCall {
  id: string;
  name: string;
  args: Record<string, unknown> | string;
}

export function completionBody(message: Record<string, unknown>, finishReason: string, usage: Record<string, unknown> = JSON_USAGE): Record<string, unknown> {
  return {
    id: "chatcmpl-fake-json",
    object: "chat.completion",
    created: 1_757_500_000,
    model: "deepseek-v4-flash",
    choices: [{ index: 0, message: { role: "assistant", ...message }, logprobs: null, finish_reason: finishReason }],
    usage,
  };
}

/** An assistant turn that calls tools. */
export function callsTurn(calls: ScriptedToolCall[], options: { reasoning?: string; content?: string; usage?: Record<string, unknown> } = {}): Record<string, unknown> {
  return completionBody(
    {
      content: options.content ?? "",
      ...(options.reasoning !== undefined ? { reasoning_content: options.reasoning } : {}),
      tool_calls: calls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: typeof call.args === "string" ? call.args : JSON.stringify(call.args) },
      })),
    },
    "tool_calls",
    options.usage,
  );
}

/** An assistant turn that ends with plain text. */
export function textTurnJson(content: string, options: { reasoning?: string; usage?: Record<string, unknown> } = {}): Record<string, unknown> {
  return completionBody({ content, ...(options.reasoning !== undefined ? { reasoning_content: options.reasoning } : {}) }, "stop", options.usage);
}

export function finishTurn(id: string, summary: string, disposition = "done"): Record<string, unknown> {
  return callsTurn([{ id, name: "finish_run", args: { disposition, summary } }]);
}

export type JsonScriptEntry =
  | Record<string, unknown>
  | ((request: RecordedHttpRequest, index: number) => Record<string, unknown> | { status: number; body: unknown });

export class FakeDeepSeekJsonServer extends RecordingHttpServer {
  private readonly script: JsonScriptEntry[] = [];
  private fallback: JsonScriptEntry | null = null;

  static async start(): Promise<FakeDeepSeekJsonServer> {
    let instance: FakeDeepSeekJsonServer | null = null;
    const server = await RecordingHttpServer.listen((req, res) => {
      void instance!.handle(req, res);
    });
    instance = new FakeDeepSeekJsonServer(server);
    return instance;
  }

  enqueue(...entries: JsonScriptEntry[]): this {
    this.script.push(...entries);
    return this;
  }

  setFallback(entry: JsonScriptEntry | null): this {
    this.fallback = entry;
    return this;
  }

  /** Drop any unconsumed scripted turns (between runs of the same test). */
  resetScript(): this {
    this.script.length = 0;
    return this;
  }

  get chatRequests(): RecordedHttpRequest[] {
    return this.requests.filter((request) => request.method === "POST" && /\/chat\/completions$/.test(request.path));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const recorded = await this.record(req);
    if (recorded.method === "GET" && /\/models$/.test(recorded.path)) {
      this.sendJson(res, 200, { object: "list", data: [{ id: "deepseek-v4-flash", object: "model", owned_by: "deepseek" }] });
      return;
    }
    if (recorded.method === "POST" && /\/chat\/completions$/.test(recorded.path)) {
      const index = this.chatRequests.length - 1;
      const entry = this.script.shift() ?? this.fallback;
      if (!entry) {
        this.sendJson(res, 500, { error: { message: `fake DeepSeek (json): no scripted response for chat request #${index}` } });
        return;
      }
      const produced = typeof entry === "function" ? entry(recorded, index) : entry;
      if (produced && typeof produced === "object" && "status" in produced && typeof (produced as { status: unknown }).status === "number" && "body" in produced) {
        const spec = produced as { status: number; body: unknown };
        this.sendJson(res, spec.status, spec.body);
        return;
      }
      this.sendJson(res, 200, produced, { "x-request-id": `req-json-${index}` });
      return;
    }
    this.sendJson(res, 404, { error: { message: `fake DeepSeek (json): unknown route ${recorded.method} ${recorded.path}` } });
  }
}

export function messagesOfRequest(request: RecordedHttpRequest): Array<Record<string, unknown>> {
  return (request.json?.messages ?? []) as Array<Record<string, unknown>>;
}

export function toolNamesOfRequest(request: RecordedHttpRequest): string[] {
  const tools = (request.json?.tools ?? []) as Array<{ function?: { name?: string } }>;
  return tools.map((tool) => String(tool.function?.name ?? ""));
}

export function toolDefinitionOfRequest(request: RecordedHttpRequest, name: string): { name: string; description: string; parameters: Record<string, unknown> } | null {
  const tools = (request.json?.tools ?? []) as Array<{ function?: { name?: string; description?: string; parameters?: Record<string, unknown> } }>;
  const found = tools.find((tool) => tool.function?.name === name);
  if (!found?.function) return null;
  return { name: String(found.function.name), description: String(found.function.description ?? ""), parameters: found.function.parameters ?? {} };
}
