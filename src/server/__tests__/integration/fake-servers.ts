/**
 * Real node:http servers used by the integration tests.
 *
 * - FakeDeepSeekServer emulates the OpenAI-compatible DeepSeek API: `GET /models`
 *   and `POST /chat/completions` (plus the `/beta` prefix) with Server-Sent-Events
 *   streaming (`data: {...}\n\n` chunks, a usage-only chunk, then `data: [DONE]`).
 *   Responses are scripted per request; SSE payloads can be split into
 *   arbitrary socket writes (including inside multi-byte UTF-8 sequences) and
 *   held open to exercise cancellation and timeouts.
 * - FakePaperclipServer emulates the handful of control-plane routes the agent
 *   uses during a heartbeat and records every request with its headers.
 *
 * Both listen on 127.0.0.1 with an ephemeral port.
 */
import http from "node:http";
import type { AddressInfo, Socket } from "node:net";

export interface RecordedRequest {
  method: string;
  /** Path including the query string. */
  url: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: string;
  json: Record<string, unknown> | null;
  /** True when the client closed the connection before the response finished. */
  aborted: boolean;
  /** True once a `holdOpen` SSE response has written its preamble and is waiting. */
  held: boolean;
  /** Number of socket writes used for an SSE response (0 for JSON/error responses). */
  writes: number;
  /**
   * Number of write boundaries that fell inside a multi-byte UTF-8 sequence
   * (the previous write ended with a partial code point).
   */
  midCodepointCuts: number;
}

export type SseChunk = Record<string, unknown>;

export interface SseSpec {
  kind: "sse";
  chunks: SseChunk[];
  /**
   * Split the raw SSE payload into separate socket writes. Default: one write
   * per SSE event. Pieces are written with a short pause between them so the
   * client observes distinct reads.
   */
  split?: (payload: Buffer) => Buffer[];
  /** Keep the response open after writing the chunks (no [DONE], no end). */
  holdOpen?: boolean;
  headers?: Record<string, string>;
}

export interface JsonSpec {
  kind: "json";
  status?: number;
  body: unknown;
  headers?: Record<string, string>;
}

export interface ErrorSpec {
  kind: "error";
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export type DeepSeekResponseSpec = SseSpec | JsonSpec | ErrorSpec;
export type ScriptEntry = DeepSeekResponseSpec | ((request: RecordedRequest) => DeepSeekResponseSpec);

const CHAT_PATHS = new Set(["/chat/completions", "/beta/chat/completions"]);

export const DEFAULT_USAGE = {
  prompt_tokens: 1000,
  completion_tokens: 100,
  prompt_cache_hit_tokens: 600,
  prompt_cache_miss_tokens: 400,
  prompt_tokens_details: { cached_tokens: 600 },
  completion_tokens_details: { reasoning_tokens: 30 },
};

export function sseDelta(delta: Record<string, unknown>, finishReason: string | null = null, model = "deepseek-v4-flash"): SseChunk {
  return {
    id: "chatcmpl-fake",
    object: "chat.completion.chunk",
    created: 1_757_500_000,
    model,
    system_fingerprint: "fp_fake",
    choices: [{ index: 0, delta, logprobs: null, finish_reason: finishReason }],
  };
}

export function sseUsage(usage: Record<string, unknown> = DEFAULT_USAGE, model = "deepseek-v4-flash"): SseChunk {
  return { id: "chatcmpl-fake", object: "chat.completion.chunk", created: 1_757_500_000, model, choices: [], usage };
}

/** Split a string into pieces of `size` code points (never inside a surrogate pair). */
export function fragments(text: string, size: number): string[] {
  const points = Array.from(text);
  const out: string[] = [];
  for (let index = 0; index < points.length; index += size) out.push(points.slice(index, index + size).join(""));
  return out.length > 0 ? out : [""];
}

export interface ToolCallScript {
  id: string;
  name: string;
  args: string | Record<string, unknown>;
  /** Number of code points per `arguments` fragment (default 12). */
  fragmentSize?: number;
}

/** A complete streamed assistant turn that ends in tool calls. */
export function toolCallTurn(
  calls: ToolCallScript[],
  options: { reasoning?: string; text?: string; usage?: Record<string, unknown> } = {},
): SseChunk[] {
  const chunks: SseChunk[] = [sseDelta({ role: "assistant", content: "" })];
  if (options.reasoning) for (const piece of fragments(options.reasoning, 6)) chunks.push(sseDelta({ reasoning_content: piece }));
  if (options.text) for (const piece of fragments(options.text, 6)) chunks.push(sseDelta({ content: piece }));
  calls.forEach((call, index) => {
    chunks.push(sseDelta({ tool_calls: [{ index, id: call.id, type: "function", function: { name: call.name, arguments: "" } }] }));
    const args = typeof call.args === "string" ? call.args : JSON.stringify(call.args);
    for (const piece of fragments(args, call.fragmentSize ?? 12)) {
      chunks.push(sseDelta({ tool_calls: [{ index, function: { arguments: piece } }] }));
    }
  });
  chunks.push(sseDelta({}, "tool_calls"));
  chunks.push(sseUsage(options.usage ?? DEFAULT_USAGE));
  return chunks;
}

/** A complete streamed assistant turn that ends with plain text. */
export function textTurn(text: string, options: { reasoning?: string; usage?: Record<string, unknown> } = {}): SseChunk[] {
  const chunks: SseChunk[] = [sseDelta({ role: "assistant", content: "" })];
  if (options.reasoning) for (const piece of fragments(options.reasoning, 6)) chunks.push(sseDelta({ reasoning_content: piece }));
  for (const piece of fragments(text, 6)) chunks.push(sseDelta({ content: piece }));
  chunks.push(sseDelta({}, "stop"));
  chunks.push(sseUsage(options.usage ?? DEFAULT_USAGE));
  return chunks;
}

export function sse(chunks: SseChunk[], extra: Omit<SseSpec, "kind" | "chunks"> = {}): SseSpec {
  return { kind: "sse", chunks, ...extra };
}

/** Non-streaming chat completion body (used by the environment test's hello probe). */
export function jsonCompletion(message: Record<string, unknown>, finishReason = "stop", usage: Record<string, unknown> = DEFAULT_USAGE): JsonSpec {
  return {
    kind: "json",
    body: {
      id: "chatcmpl-fake",
      object: "chat.completion",
      created: 1_757_500_000,
      model: "deepseek-v4-flash",
      choices: [{ index: 0, message: { role: "assistant", ...message }, logprobs: null, finish_reason: finishReason }],
      usage,
    },
  };
}

export function apiError(status: number, message: string, extra: { type?: string; code?: string; headers?: Record<string, string> } = {}): ErrorSpec {
  return {
    kind: "error",
    status,
    body: { error: { message, type: extra.type ?? "invalid_request_error", param: null, code: extra.code ?? null } },
    headers: extra.headers,
  };
}

export function encodeSse(chunks: SseChunk[], done: boolean): Buffer {
  const events = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`);
  if (done) events.push("data: [DONE]\n\n");
  return Buffer.from(events.join(""), "utf8");
}

/** One write per SSE event (the boundary is the blank line). */
export function splitPerEvent(payload: Buffer): Buffer[] {
  const pieces: Buffer[] = [];
  let start = 0;
  const marker = Buffer.from("\n\n");
  let index = payload.indexOf(marker, start);
  while (index !== -1) {
    pieces.push(payload.subarray(start, index + 2));
    start = index + 2;
    index = payload.indexOf(marker, start);
  }
  if (start < payload.length) pieces.push(payload.subarray(start));
  return pieces;
}

/**
 * Split per event AND additionally cut every occurrence of the given
 * characters in the middle of their UTF-8 byte sequence, so the client's
 * decoder receives partial code points at read boundaries.
 */
export function splitInsideMultibyte(chars: string[]): (payload: Buffer) => Buffer[] {
  return (payload: Buffer) => {
    const cuts = new Set<number>();
    for (const char of chars) {
      const bytes = Buffer.from(char, "utf8");
      if (bytes.length < 2) continue;
      let from = payload.indexOf(bytes);
      while (from !== -1) {
        cuts.add(from + 1);
        if (bytes.length > 2) cuts.add(from + bytes.length - 1);
        from = payload.indexOf(bytes, from + bytes.length);
      }
    }
    const pieces: Buffer[] = [];
    for (const event of splitPerEvent(payload)) {
      // `event` is a subarray of `payload`; recover its offset inside the payload.
      const base = event.byteOffset - payload.byteOffset;
      const local = [...cuts].filter((cut) => cut > base && cut < base + event.length).map((cut) => cut - base).sort((a, b) => a - b);
      let last = 0;
      for (const cut of local) {
        pieces.push(event.subarray(last, cut));
        last = cut;
      }
      pieces.push(event.subarray(last));
    }
    return pieces.filter((piece) => piece.length > 0);
  };
}

export function splitEveryBytes(size: number): (payload: Buffer) => Buffer[] {
  return (payload: Buffer) => {
    const pieces: Buffer[] = [];
    for (let index = 0; index < payload.length; index += size) pieces.push(payload.subarray(index, index + size));
    return pieces;
  };
}

/** Count write boundaries where the next piece starts with a UTF-8 continuation byte. */
export function countMidCodepointCuts(pieces: Buffer[]): number {
  let cuts = 0;
  for (let index = 1; index < pieces.length; index += 1) {
    const first = pieces[index]![0];
    if (first !== undefined && (first & 0xc0) === 0x80) cuts += 1;
  }
  return cuts;
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const parts: Buffer[] = [];
  for await (const chunk of req) parts.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(parts).toString("utf8");
}

function parseJson(text: string): Record<string, unknown> | null {
  if (!text.trim()) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

abstract class RecordingServer {
  readonly requests: RecordedRequest[] = [];
  readonly baseUrl: string;
  protected readonly server: http.Server;
  private readonly sockets = new Set<Socket>();
  private readonly waiters: Array<{ predicate: (requests: RecordedRequest[]) => boolean; resolve: () => void }> = [];

  protected constructor(server: http.Server) {
    this.server = server;
    const address = server.address() as AddressInfo;
    this.baseUrl = `http://127.0.0.1:${address.port}`;
    server.on("connection", (socket) => {
      socket.setNoDelay(true);
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

  protected async record(req: http.IncomingMessage, res: http.ServerResponse): Promise<RecordedRequest> {
    const body = await readBody(req);
    const url = req.url ?? "/";
    const recorded: RecordedRequest = {
      method: req.method ?? "GET",
      url,
      path: url.split("?")[0]!,
      headers: req.headers,
      body,
      json: parseJson(body),
      aborted: false,
      held: false,
      writes: 0,
      midCodepointCuts: 0,
    };
    res.on("close", () => {
      if (!res.writableFinished) {
        recorded.aborted = true;
        this.notify();
      }
    });
    this.requests.push(recorded);
    this.notify();
    return recorded;
  }

  protected notify(): void {
    for (const waiter of [...this.waiters]) {
      if (waiter.predicate(this.requests)) {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    }
  }

  /** Resolve once the recorded requests satisfy `predicate` (rejects after `timeoutMs`). */
  waitFor(predicate: (requests: RecordedRequest[]) => boolean, timeoutMs = 5000): Promise<void> {
    if (predicate(this.requests)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex((entry) => entry.resolve === done);
        if (index !== -1) this.waiters.splice(index, 1);
        reject(new Error(`fake server: condition not met within ${timeoutMs}ms (${this.requests.length} requests seen)`));
      }, timeoutMs);
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      this.waiters.push({ predicate, resolve: done });
    });
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

export class FakeDeepSeekServer extends RecordingServer {
  models: string[] = ["deepseek-v4-flash", "deepseek-v4-pro"];
  /** Delay between socket writes of one SSE response. */
  pieceDelayMs = 1;
  private readonly script: ScriptEntry[] = [];
  private fallback: ScriptEntry | null = null;
  private readonly heldResponses = new Set<http.ServerResponse>();

  static async start(): Promise<FakeDeepSeekServer> {
    let instance: FakeDeepSeekServer | null = null;
    const server = await RecordingServer.listen((req, res) => {
      void instance!.handle(req, res);
    });
    instance = new FakeDeepSeekServer(server);
    return instance;
  }

  /** Queue scripted responses for the next chat completion requests, in order. */
  enqueue(...entries: ScriptEntry[]): this {
    this.script.push(...entries);
    return this;
  }

  /** Response used when the script is exhausted. */
  setFallback(entry: ScriptEntry | null): this {
    this.fallback = entry;
    return this;
  }

  get chatRequests(): RecordedRequest[] {
    return this.requests.filter((request) => CHAT_PATHS.has(request.path));
  }

  get modelRequests(): RecordedRequest[] {
    return this.requests.filter((request) => request.path === "/models" || request.path === "/beta/models");
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const recorded = await this.record(req, res);
    if (recorded.method === "GET" && (recorded.path === "/models" || recorded.path === "/beta/models")) {
      this.writeJson(res, 200, { object: "list", data: this.models.map((id) => ({ id, object: "model", owned_by: "deepseek" })) });
      return;
    }
    if (recorded.method === "POST" && CHAT_PATHS.has(recorded.path)) {
      const entry = this.script.shift() ?? this.fallback;
      if (!entry) {
        this.writeJson(res, 500, { error: { message: `fake DeepSeek: no scripted response for request #${this.chatRequests.length}` } });
        return;
      }
      const spec = typeof entry === "function" ? entry(recorded) : entry;
      await this.respond(spec, recorded, res);
      return;
    }
    this.writeJson(res, 404, { error: { message: `fake DeepSeek: unknown route ${recorded.method} ${recorded.path}` } });
  }

  private writeJson(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload), ...headers });
    res.end(payload);
  }

  private async respond(spec: DeepSeekResponseSpec, recorded: RecordedRequest, res: http.ServerResponse): Promise<void> {
    if (spec.kind === "json") {
      this.writeJson(res, spec.status ?? 200, spec.body, spec.headers);
      return;
    }
    if (spec.kind === "error") {
      this.writeJson(res, spec.status, spec.body, spec.headers);
      return;
    }
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-request-id": `req-${this.requests.length}`,
      ...(spec.headers ?? {}),
    });
    res.flushHeaders();
    const payload = encodeSse(spec.chunks, !spec.holdOpen);
    const pieces = (spec.split ?? splitPerEvent)(payload);
    recorded.midCodepointCuts = countMidCodepointCuts(pieces);
    for (const piece of pieces) {
      if (res.destroyed) return;
      res.write(piece);
      recorded.writes += 1;
      await pause(this.pieceDelayMs);
    }
    if (spec.holdOpen) {
      recorded.held = true;
      this.heldResponses.add(res);
      res.on("close", () => this.heldResponses.delete(res));
      this.notify();
      return;
    }
    res.end();
  }

  override async close(): Promise<void> {
    for (const res of this.heldResponses) res.destroy();
    this.heldResponses.clear();
    await super.close();
  }
}

export interface FakePaperclipState {
  agent: { id: string; name: string; companyId: string };
  issues: Record<string, Record<string, unknown>>;
  comments: Array<Record<string, unknown>>;
}

export class FakePaperclipServer extends RecordingServer {
  readonly state: FakePaperclipState = {
    agent: { id: "agent-1", name: "DeepSeek Coder", companyId: "company-1" },
    issues: {
      "issue-42": { id: "issue-42", identifier: "ISS-42", title: "Write the notes file", status: "todo", assigneeAgentId: "agent-1", priority: "medium" },
    },
    comments: [],
  };

  static async start(): Promise<FakePaperclipServer> {
    let instance: FakePaperclipServer | null = null;
    const server = await RecordingServer.listen((req, res) => {
      void instance!.handle(req, res);
    });
    instance = new FakePaperclipServer(server);
    return instance;
  }

  get mutatingRequests(): RecordedRequest[] {
    return this.requests.filter((request) => request.method !== "GET");
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const recorded = await this.record(req, res);
    const send = (status: number, body: unknown) => {
      const payload = JSON.stringify(body);
      res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
      res.end(payload);
    };
    const auth = recorded.headers.authorization ?? "";
    if (!auth.startsWith("Bearer ")) {
      send(401, { error: "missing bearer token" });
      return;
    }
    const { method, path } = recorded;
    if (method === "GET" && path === "/api/agents/me") {
      send(200, { ...this.state.agent, status: "active", adapterType: "deepseek_api" });
      return;
    }
    if (method === "GET" && path === "/api/agents/me/inbox-lite") {
      send(200, {
        assignedTasks: Object.values(this.state.issues).map((issue) => ({ id: issue.id, identifier: issue.identifier, title: issue.title, status: issue.status })),
        mentions: [],
        approvals: [],
      });
      return;
    }
    const issueMatch = path.match(/^\/api\/issues\/([^/]+)(?:\/(checkout|heartbeat-context|comments))?$/);
    if (issueMatch) {
      const issueId = issueMatch[1]!;
      const sub = issueMatch[2] ?? "";
      const issue = this.state.issues[issueId];
      if (!issue) {
        send(404, { error: "issue not found", issueId });
        return;
      }
      if (method !== "GET" && !recorded.headers["x-paperclip-run-id"]) {
        send(400, { error: "X-Paperclip-Run-Id header is required on mutating requests" });
        return;
      }
      if (method === "POST" && sub === "checkout") {
        if (issue.status === "in_progress" && issue.checkedOutBy && issue.checkedOutBy !== recorded.json?.agentId) {
          send(409, { error: "issue is checked out by another agent" });
          return;
        }
        issue.status = "in_progress";
        issue.checkedOutBy = recorded.json?.agentId ?? this.state.agent.id;
        send(200, { ...issue });
        return;
      }
      if (method === "GET" && sub === "heartbeat-context") {
        send(200, { issue: { ...issue }, comments: this.state.comments.filter((comment) => comment.issueId === issueId), subtasks: [], documents: [] });
        return;
      }
      if (method === "POST" && sub === "comments") {
        const comment = { id: `comment-${this.state.comments.length + 1}`, issueId, body: recorded.json?.body ?? "", authorAgentId: this.state.agent.id };
        this.state.comments.push(comment);
        send(201, comment);
        return;
      }
      if (method === "PATCH" && sub === "") {
        Object.assign(issue, recorded.json ?? {});
        send(200, { ...issue });
        return;
      }
      if (method === "GET" && sub === "") {
        send(200, { ...issue });
        return;
      }
    }
    send(404, { error: `unknown route ${method} ${path}` });
  }
}
