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
  fetchImpl?: typeof fetch;
  defaultTimeoutMs?: number;
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
  if (query && typeof query === "object" && !Array.isArray(query)) {
    for (const [key, value] of Object.entries(query as Record<string, unknown>)) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) url.searchParams.set(key, value.map(String).join(","));
      else url.searchParams.set(key, String(value));
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
        path: { type: "string", description: "API path, e.g. /api/issues/{issueId}/comments. Substitute real ids." },
        query: {
          type: "object",
          description: "Optional query-string parameters (values are stringified; arrays become comma lists).",
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
      let url: string;
      try {
        url = buildPaperclipRequestUrl(options.apiUrl, rawPath, args.query);
      } catch (err) {
        return toolErrorResult(`Invalid path: ${err instanceof Error ? err.message : String(err)}`);
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
