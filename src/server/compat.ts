/**
 * Forward-compatibility shims for adapter-utils fields that newer Paperclip
 * servers pass to adapters but that are not yet part of the published
 * `@paperclipai/adapter-utils` typings this package compiles against
 * (run-scoped cancellation signal, dispatch callbacks, runtime connection
 * tools). Everything is read defensively so the adapter works on both.
 */
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";

export type ExecutionErrorFamily = NonNullable<AdapterExecutionResult["errorFamily"]>;

export interface RuntimeToolAccess {
  version: number;
  guidance: string;
  mcpEndpoint: string;
  rest: {
    connectionsSearch: string;
    connectionRequest: string;
  };
  bearerToken: string;
  expiresAt: string;
  tools: readonly string[];
}

export type ExtendedExecutionContext = AdapterExecutionContext & {
  /** Run-scoped operator cancellation (newer servers). */
  signal?: AbortSignal;
  /** Opt in to signal-based cancellation before starting provider work. */
  onCancellationReady?: () => Promise<void>;
  /** Reports that execution crossed the adapter's dispatch boundary. */
  onDispatch?: () => void;
  /** Run-scoped connection tools delivered through the invocation context. */
  runtimeTools?: RuntimeToolAccess;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readRuntimeToolAccess(ctx: AdapterExecutionContext): RuntimeToolAccess | null {
  const raw = (ctx as ExtendedExecutionContext).runtimeTools;
  if (!isRecord(raw)) return null;
  const rest = isRecord(raw.rest) ? raw.rest : null;
  if (!rest || typeof rest.connectionsSearch !== "string" || typeof rest.connectionRequest !== "string") return null;
  if (typeof raw.bearerToken !== "string" || !raw.bearerToken) return null;
  const tools = Array.isArray(raw.tools) ? raw.tools.filter((entry): entry is string => typeof entry === "string") : [];
  return {
    version: typeof raw.version === "number" ? raw.version : 1,
    guidance: typeof raw.guidance === "string" ? raw.guidance : "",
    mcpEndpoint: typeof raw.mcpEndpoint === "string" ? raw.mcpEndpoint : "",
    rest: { connectionsSearch: rest.connectionsSearch, connectionRequest: rest.connectionRequest },
    bearerToken: raw.bearerToken,
    expiresAt: typeof raw.expiresAt === "string" ? raw.expiresAt : "",
    tools,
  };
}

/** Same variables the built-in adapters export for shell-based runtimes. */
export function buildRuntimeToolsEnv(access: RuntimeToolAccess | null | undefined): Record<string, string> {
  if (!access) return {};
  return {
    PAPERCLIP_RUNTIME_TOOLS_MCP_URL: access.mcpEndpoint,
    PAPERCLIP_RUNTIME_TOOLS_TOKEN: access.bearerToken,
    PAPERCLIP_RUNTIME_TOOLS_EXPIRES_AT: access.expiresAt,
    PAPERCLIP_RUNTIME_TOOLS_CONNECTIONS_SEARCH_URL: access.rest.connectionsSearch,
    PAPERCLIP_RUNTIME_TOOLS_CONNECTION_REQUEST_URL: access.rest.connectionRequest,
    PAPERCLIP_RUNTIME_TOOLS_AVAILABLE: access.tools.join(","),
    PAPERCLIP_RUNTIME_TOOLS_GUIDANCE: access.guidance,
  };
}
