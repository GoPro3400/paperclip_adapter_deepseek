/**
 * Minimal MCP (Model Context Protocol) client over the Streamable HTTP
 * transport, used to expose Paperclip runtime MCP servers (company
 * connections, tool gateways) to the DeepSeek model as ordinary functions.
 *
 * Only `initialize`, `notifications/initialized`, `tools/list` and
 * `tools/call` are implemented; that is all a run-scoped tool bridge needs.
 */
import type { AdapterRuntimeMcpServer } from "@paperclipai/adapter-utils";
import type { JsonSchema } from "../json-schema.js";
import type { ToolDefinition, ToolResult } from "./registry.js";
import { sanitizeToolName, toolErrorResult } from "./registry.js";
import { safeJsonStringify } from "../text.js";

export const MCP_PROTOCOL_VERSION = "2025-06-18";
const MCP_ACCEPT = "application/json, text/event-stream";

export interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

interface JsonRpcResponse {
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseMcpResponseBody(bodyText: string, contentType: string | null): JsonRpcResponse | null {
  const isEventStream = (contentType ?? "").toLowerCase().includes("text/event-stream");
  if (!isEventStream) {
    if (!bodyText.trim()) return null;
    return JSON.parse(bodyText) as JsonRpcResponse;
  }
  const events = bodyText.replace(/\r\n/g, "\n").split(/\n\n+/);
  let fallback: JsonRpcResponse | null = null;
  for (const event of events) {
    const dataLines = event.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, ""));
    if (dataLines.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(dataLines.join("\n"));
    } catch {
      continue;
    }
    if (isRecord(parsed) && ("result" in parsed || "error" in parsed)) return parsed as JsonRpcResponse;
    if (fallback === null && isRecord(parsed)) fallback = parsed as JsonRpcResponse;
  }
  return fallback;
}

export class McpHttpClient {
  private sessionHeaders: Record<string, string> | null = null;
  private requestCounter = 0;

  constructor(
    private readonly server: AdapterRuntimeMcpServer,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
    private readonly timeoutMs = 60_000,
  ) {}

  get name(): string {
    return this.server.name;
  }

  private baseHeaders(): Record<string, string> {
    return {
      authorization: `Bearer ${this.server.token}`,
      "content-type": "application/json",
      accept: MCP_ACCEPT,
      ...(this.sessionHeaders ?? {}),
    };
  }

  private async send(payload: Record<string, unknown>, signal?: AbortSignal): Promise<{ response: Response; body: JsonRpcResponse | null }> {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.server.url, {
        method: "POST",
        headers: this.baseHeaders(),
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`MCP server ${this.server.name} returned HTTP ${response.status}${text ? `: ${text.slice(0, 300)}` : ""}`);
      }
      const body = text.trim() ? parseMcpResponseBody(text, response.headers.get("content-type")) : null;
      return { response, body };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  async initialize(signal?: AbortSignal): Promise<void> {
    if (this.sessionHeaders) return;
    const { response, body } = await this.send(
      {
        jsonrpc: "2.0",
        id: `init-${++this.requestCounter}`,
        method: "initialize",
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "paperclip-adapter-deepseek", version: "1" },
        },
      },
      signal,
    );
    if (body?.error) throw new Error(`MCP initialize failed: ${body.error.message ?? JSON.stringify(body.error)}`);
    const result = isRecord(body?.result) ? body!.result : {};
    const protocolVersion = typeof result.protocolVersion === "string" && result.protocolVersion ? result.protocolVersion : MCP_PROTOCOL_VERSION;
    const sessionId = response.headers.get("mcp-session-id");
    this.sessionHeaders = {
      "MCP-Protocol-Version": protocolVersion,
      ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
    };
    await this.send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }, signal).catch(() => undefined);
  }

  async listTools(signal?: AbortSignal): Promise<McpToolDescriptor[]> {
    await this.initialize(signal);
    const { body } = await this.send({ jsonrpc: "2.0", id: `list-${++this.requestCounter}`, method: "tools/list", params: {} }, signal);
    if (body?.error) throw new Error(`MCP tools/list failed: ${body.error.message ?? JSON.stringify(body.error)}`);
    const tools = isRecord(body?.result) && Array.isArray(body!.result.tools) ? body!.result.tools : [];
    return tools
      .map((entry) => {
        if (!isRecord(entry) || typeof entry.name !== "string") return null;
        const schema = isRecord(entry.inputSchema) ? (entry.inputSchema as JsonSchema) : { type: "object", properties: {} };
        return {
          name: entry.name,
          description: typeof entry.description === "string" ? entry.description : "",
          inputSchema: schema.type ? schema : { ...schema, type: "object" },
        };
      })
      .filter((entry): entry is McpToolDescriptor => entry !== null);
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<{ text: string; isError: boolean; structured?: unknown }> {
    await this.initialize(signal);
    const { body } = await this.send(
      { jsonrpc: "2.0", id: `call-${++this.requestCounter}`, method: "tools/call", params: { name, arguments: args } },
      signal,
    );
    if (body?.error) {
      return { text: `MCP error ${body.error.code ?? ""}: ${body.error.message ?? JSON.stringify(body.error)}`, isError: true };
    }
    const result = isRecord(body?.result) ? body!.result : {};
    const content = Array.isArray(result.content) ? result.content : [];
    const textParts = content.map((part) => {
      if (!isRecord(part)) return "";
      if (part.type === "text" && typeof part.text === "string") return part.text;
      if (part.type === "resource" && isRecord(part.resource) && typeof part.resource.text === "string") return part.resource.text;
      return `[${String(part.type ?? "content")}]`;
    });
    const text = textParts.filter(Boolean).join("\n") || safeJsonStringify(result.structuredContent ?? result);
    return { text, isError: result.isError === true, structured: result.structuredContent };
  }
}

export function mcpToolName(serverName: string, toolName: string): string {
  const serverSlug = sanitizeToolName(serverName.toLowerCase().replace(/\s+/g, "_")).slice(0, 20);
  return sanitizeToolName(`mcp_${serverSlug}_${toolName}`);
}

export async function createMcpTools(input: {
  servers: AdapterRuntimeMcpServer[];
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  onWarning: (message: string) => Promise<void>;
  reservedNames: Set<string>;
}): Promise<ToolDefinition[]> {
  const tools: ToolDefinition[] = [];
  const used = new Set(input.reservedNames);
  for (const server of input.servers) {
    const client = new McpHttpClient(server, input.fetchImpl);
    let descriptors: McpToolDescriptor[];
    try {
      descriptors = await client.listTools(input.signal);
    } catch (err) {
      await input.onWarning(`MCP server "${server.name}" unavailable: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    for (const descriptor of descriptors) {
      let name = mcpToolName(server.name, descriptor.name);
      let suffix = 2;
      while (used.has(name)) {
        name = sanitizeToolName(`${name.slice(0, 60)}_${suffix}`);
        suffix += 1;
      }
      used.add(name);
      tools.push({
        name,
        group: "mcp",
        description: `[MCP: ${server.name}] ${descriptor.description || descriptor.name}`.slice(0, 1024),
        parameters: descriptor.inputSchema,
        handler: async (args, runtime): Promise<ToolResult> => {
          try {
            const result = await client.callTool(descriptor.name, args, runtime.signal);
            return { content: result.text, isError: result.isError };
          } catch (err) {
            return toolErrorResult(`MCP tool ${descriptor.name} failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        },
      });
    }
  }
  return tools;
}
