/**
 * paperclip_api: authenticated access to the Paperclip control plane.
 *
 * The model never sees the run token; the tool injects `Authorization` and the
 * `X-Paperclip-Run-Id` audit header (required on every mutating request by the
 * Paperclip skill contract) and returns the parsed response.
 */
import type { ToolDefinition, ToolResult } from "./registry.js";
import { toolErrorResult } from "./registry.js";
import { safeJsonStringify, truncateMiddle } from "../text.js";

export interface PaperclipApiToolOptions {
  apiUrl: string;
  apiKey: string;
  runId: string;
  agentId: string;
  companyId: string;
  /** Task/issue id of the wake, substituted for `$PAPERCLIP_TASK_ID` placeholders. */
  taskId?: string | null;
  fetchImpl?: typeof fetch;
  defaultTimeoutMs?: number;
}

/**
 * Replaces the shell-style placeholders the heartbeat template uses
 * (`$PAPERCLIP_TASK_ID`, `${PAPERCLIP_AGENT_ID}`, ...) and the `{agentId}` /
 * `{companyId}` placeholders of the protocol examples with run values, and
 * names any placeholder that is still unresolved.
 */
export function substitutePathPlaceholders(
  rawPath: string,
  ids: { taskId?: string | null; agentId: string; companyId: string },
): { path: string; unresolved: string[] } {
  const values: Record<string, string | null | undefined> = {
    PAPERCLIP_TASK_ID: ids.taskId,
    PAPERCLIP_ISSUE_ID: ids.taskId,
    PAPERCLIP_AGENT_ID: ids.agentId,
    PAPERCLIP_COMPANY_ID: ids.companyId,
    agentId: ids.agentId,
    companyId: ids.companyId,
  };
  const substituted = rawPath
    .replace(/\$\{?(PAPERCLIP_[A-Z0-9_]+)\}?/g, (match, name: string) => values[name] || match)
    .replace(/\{(agentId|companyId)\}/g, (match, name: string) => values[name] || match);
  const unresolved = [...substituted.matchAll(/\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|\{[^/{}]*\}|<[^/<>]*>|(?<=\/):[A-Za-z_][A-Za-z0-9_]*/g)].map((entry) => entry[0]);
  return { path: substituted, unresolved };
}

const ALLOWED_METHODS = ["GET", "POST", "PATCH", "PUT", "DELETE"] as const;
type ApiMethod = (typeof ALLOWED_METHODS)[number];

/** `PAPERCLIP_API_URL` may or may not carry a trailing `/api`; normalize to the host root. */
export function normalizePaperclipApiBase(apiUrl: string): string {
  let base = apiUrl.trim().replace(/\/+$/, "");
  if (base.toLowerCase().endsWith("/api")) base = base.slice(0, -4);
  return base;
}

export function buildPaperclipRequestUrl(apiUrl: string, rawPath: string, query: unknown): string {
  const base = normalizePaperclipApiBase(apiUrl);
  let apiPath = rawPath.trim();
  if (!apiPath.startsWith("/")) apiPath = `/${apiPath}`;
  if (!apiPath.startsWith("/api/") && apiPath !== "/api") apiPath = `/api${apiPath}`;
  const url = new URL(`${base}${apiPath}`);
  // `new URL()` resolves dot segments, so `/api/../x` would leave the API namespace.
  if (url.pathname !== "/api" && !url.pathname.startsWith("/api/")) {
    throw new Error(`path must stay under /api/ (resolved to ${url.pathname})`);
  }
  if (query && typeof query === "object" && !Array.isArray(query)) {
    for (const [key, value] of Object.entries(query as Record<string, unknown>)) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        if (value.some((item) => typeof item === "object" && item !== null)) {
          throw new Error(`query parameter "${key}" must be an array of strings, numbers or booleans`);
        }
        url.searchParams.set(key, value.map(String).join(","));
      } else if (typeof value === "object") {
        throw new Error(`query parameter "${key}" must be a string, number, boolean or array (nested objects are not supported; flatten them, e.g. status=todo)`);
      } else {
        url.searchParams.set(key, String(value));
      }
    }
  }
  return url.toString();
}

export function createPaperclipApiTool(options: PaperclipApiToolOptions): ToolDefinition {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.defaultTimeoutMs ?? 60_000;
  return {
    name: "paperclip_api",
    group: "paperclip",
    description: [
      "Call the Paperclip control-plane REST API as this agent. Authentication and the X-Paperclip-Run-Id",
      "audit header are added automatically. Use it for identity (GET /api/agents/me), inbox (GET /api/agents/me/inbox-lite),",
      "checkout (POST /api/issues/{id}/checkout), context (GET /api/issues/{id}/heartbeat-context), comments",
      "(POST /api/issues/{id}/comments), status updates (PATCH /api/issues/{id}), subtasks, documents, approvals and interactions.",
      "Paths start with /api/. GET /api/openapi.json lists every route with schemas. Never retry a 409 checkout conflict.",
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        method: { type: "string", enum: [...ALLOWED_METHODS], description: "HTTP method." },
        path: {
          type: "string",
          description:
            "API path with real ids in it, e.g. /api/issues/PAP-12/comments (the task id is in the heartbeat facts). Example placeholders such as {issueId} are rejected; $PAPERCLIP_TASK_ID, $PAPERCLIP_AGENT_ID and $PAPERCLIP_COMPANY_ID are filled in automatically when known.",
        },
        query: {
          type: "object",
          description: "Optional query-string parameters (string, number, boolean or array values; arrays become comma lists).",
          additionalProperties: true,
        },
        body: {
          description: "Optional JSON request body for POST/PATCH/PUT/DELETE.",
          anyOf: [{ type: "object", additionalProperties: true }, { type: "array" }, { type: "string" }],
        },
        timeout_sec: { type: "integer", minimum: 1, maximum: 300, description: "Request timeout in seconds (default 60)." },
      },
      required: ["method", "path"],
      additionalProperties: false,
    },
    handler: async (args, runtime): Promise<ToolResult> => {
      const method = String(args.method ?? "GET").toUpperCase() as ApiMethod;
      if (!ALLOWED_METHODS.includes(method)) return toolErrorResult(`Unsupported method ${method}`);
      const rawPath = String(args.path ?? "").trim();
      if (!rawPath) return toolErrorResult("path is required");
      if (/^https?:\/\//i.test(rawPath)) return toolErrorResult("path must be an API path such as /api/agents/me, not a full URL");
      const placeholders = substitutePathPlaceholders(rawPath, { taskId: options.taskId, agentId: options.agentId, companyId: options.companyId });
      if (placeholders.unresolved.length > 0) {
        return toolErrorResult(
          `path contains unresolved placeholder(s) ${placeholders.unresolved.map((entry) => `"${entry}"`).join(", ")}: substitute the real id (the task/issue id is in the heartbeat facts, other ids come from your inbox or earlier API responses).`,
          { path: rawPath, ...(options.taskId ? { taskId: options.taskId } : {}), agentId: options.agentId, companyId: options.companyId },
        );
      }
      let url: string;
      try {
        url = buildPaperclipRequestUrl(options.apiUrl, placeholders.path, args.query);
      } catch (err) {
        return toolErrorResult(`Invalid request: ${err instanceof Error ? err.message : String(err)}`);
      }
      const headers: Record<string, string> = {
        authorization: `Bearer ${options.apiKey}`,
        accept: "application/json",
      };
      if (method !== "GET") headers["x-paperclip-run-id"] = options.runId;
      let body: string | undefined;
      if (args.body !== undefined && method !== "GET") {
        body = typeof args.body === "string" ? args.body : safeJsonStringify(args.body);
        headers["content-type"] = "application/json";
      }
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      runtime.signal?.addEventListener("abort", onAbort, { once: true });
      const requestTimeout = typeof args.timeout_sec === "number" ? args.timeout_sec * 1000 : timeoutMs;
      const timer = setTimeout(() => controller.abort(), requestTimeout);
      const startedAt = Date.now();
      try {
        const response = await fetchImpl(url, { method, headers, body, signal: controller.signal });
        const text = await response.text();
        let parsed: unknown = null;
        if (text.trim()) {
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = null;
          }
        }
        const payload = parsed ?? (text.trim() ? truncateMiddle(text, runtime.maxOutputChars).text : null);
        const summary: Record<string, unknown> = {
          ok: response.ok,
          status: response.status,
          method,
          url: url.replace(/\?.*$/, ""),
          duration_ms: Date.now() - startedAt,
          body: payload,
        };
        if (!response.ok) {
          summary.error = `Paperclip API returned HTTP ${response.status}`;
          if (response.status === 409) {
            summary.hint = "409 means another actor owns this resource. Do not retry; pick different work.";
          } else if (response.status === 401 || response.status === 403) {
            summary.hint = "The run token was rejected or lacks permission for this action.";
          } else if (response.status === 404) {
            summary.hint = "Check the id and path. GET /api/openapi.json documents every route.";
          } else if (response.status === 422 || response.status === 400) {
            summary.hint = "The request body failed validation; read the error details and fix the payload.";
          }
        } else if (method === "PATCH" && !text.trim()) {
          summary.warning = "Empty response body: the update may not have been applied. Verify with a GET.";
        }
        return { content: safeJsonStringify(summary), isError: !response.ok };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const timedOut = controller.signal.aborted && !runtime.signal?.aborted;
        return toolErrorResult(timedOut ? `Paperclip API request timed out after ${requestTimeout}ms` : `Paperclip API request failed: ${message}`, {
          method,
          url: url.replace(/\?.*$/, ""),
        });
      } finally {
        clearTimeout(timer);
        runtime.signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}
