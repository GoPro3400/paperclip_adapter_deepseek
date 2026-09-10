/**
 * Paperclip runtime connection tools (connections_search / connection_request)
 * delivered through the run's invocation context. They call the REST endpoints
 * the server advertises with the short-lived bearer token minted for this run.
 */
import type { RuntimeToolAccess } from "../compat.js";
import type { ToolDefinition, ToolResult } from "./registry.js";
import { toolErrorResult } from "./registry.js";
import { safeJsonStringify } from "../text.js";

const CONNECTIONS_SEARCH_DESCRIPTION = [
  "Search Paperclip's catalog services and authorized configured custom connections and report this run's agent-relative access state.",
  "Use it when work requires a known external service and usable access is uncertain; do not use it for arbitrary MCP URLs or unrelated work.",
].join(" ");

const CONNECTION_REQUEST_DESCRIPTION = [
  "Request access to a known connectable service for this run's agent from the responsible user.",
  "Call it only with the service identifier returned as available or needs_user_action by connections_search; if user action is needed, finish independent work, then yield without retrying or asking for credentials in comments.",
].join(" ");

async function postJson(
  fetchImpl: typeof fetch,
  url: string,
  token: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<ToolResult> {
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(body),
      signal,
    });
    const text = await response.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // keep text
    }
    if (!response.ok) {
      return toolErrorResult(`Runtime tool request failed with HTTP ${response.status}`, { response: parsed });
    }
    return { content: safeJsonStringify({ ok: true, result: parsed }) };
  } catch (err) {
    return toolErrorResult(`Runtime tool request failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function createConnectionTools(
  access: RuntimeToolAccess,
  fetchImpl: typeof fetch = globalThis.fetch,
): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  if (access.tools.includes("connections_search")) {
    tools.push({
      name: "connections_search",
      group: "connections",
      description: CONNECTIONS_SEARCH_DESCRIPTION,
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", minLength: 1, description: "Service name or capability, e.g. github, google sheets, slack." },
        },
        required: ["query"],
        additionalProperties: false,
      },
      handler: async (args, runtime) =>
        postJson(fetchImpl, access.rest.connectionsSearch, access.bearerToken, { query: String(args.query ?? "") }, runtime.signal),
    });
  }
  if (access.tools.includes("connection_request")) {
    tools.push({
      name: "connection_request",
      group: "connections",
      description: CONNECTION_REQUEST_DESCRIPTION,
      parameters: {
        type: "object",
        properties: {
          service: { type: "string", minLength: 1, description: "Service identifier returned by connections_search." },
        },
        required: ["service"],
        additionalProperties: false,
      },
      handler: async (args, runtime) =>
        postJson(fetchImpl, access.rest.connectionRequest, access.bearerToken, { service: String(args.service ?? "") }, runtime.signal),
    });
  }
  return tools;
}
