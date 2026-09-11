/**
 * Forward-compatibility shims for adapter-utils fields that newer Paperclip
 * servers pass to adapters but that are not yet part of the published
 * `@paperclipai/adapter-utils` typings this package compiles against
 * (run-scoped cancellation signal, dispatch callbacks, runtime connection
 * tools). Everything is read defensively so the adapter works on both.
 */
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { parseObject } from "@paperclipai/adapter-utils/server-utils";

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
  /** Current-request snapshot (objective, messages, completed actions) on newer servers. */
  executionContinuation?: Record<string, unknown> | null;
};

/**
 * Shape of the `executionContinuation` envelope newer servers attach to the
 * execution context and the wake payload. Only the fields the adapter renders
 * are typed; the raw envelope is forwarded to tools unchanged.
 */
export interface ExecutionContinuationSnapshot {
  raw: Record<string, unknown>;
  issueId: string | null;
  objective: string;
  trigger: Record<string, unknown> | null;
  messages: Array<Record<string, unknown>>;
  interactionOutcomes: unknown[];
  completedActions: unknown[];
  completedWork: string | null;
  recoveryOutcomes: unknown[];
  unresolvedInteractionIds: string[];
  coverage: Record<string, unknown> | null;
  resumeDelta: { baseRunId: string; messages: Array<Record<string, unknown>> } | null;
}

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

function recordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

/**
 * Reads the executionContinuation envelope from the invocation context (master
 * servers) or from the wake payload, whichever carries it. Returns null when
 * absent or of an unknown version.
 */
export function readExecutionContinuation(ctx: AdapterExecutionContext): ExecutionContinuationSnapshot | null {
  const fromContext = (ctx as ExtendedExecutionContext).executionContinuation;
  const raw = isRecord(fromContext) ? fromContext : parseObject(parseObject(ctx.context.paperclipWake).executionContinuation);
  if (!isRecord(raw) || raw.version !== 1) return null;
  const delta = parseObject(raw.resumeDelta);
  const resumeDelta = typeof delta.baseRunId === "string" && Array.isArray(delta.messages)
    ? { baseRunId: delta.baseRunId, messages: recordArray(delta.messages) }
    : null;
  return {
    raw,
    issueId: typeof raw.issueId === "string" ? raw.issueId : null,
    objective: typeof raw.objective === "string" ? raw.objective : "",
    trigger: isRecord(raw.trigger) ? raw.trigger : null,
    messages: recordArray(raw.messages),
    interactionOutcomes: Array.isArray(raw.interactionOutcomes) ? raw.interactionOutcomes : [],
    completedActions: Array.isArray(raw.completedActions) ? raw.completedActions : [],
    completedWork: typeof raw.completedWork === "string" ? raw.completedWork : null,
    recoveryOutcomes: Array.isArray(raw.recoveryOutcomes) ? raw.recoveryOutcomes : [],
    unresolvedInteractionIds: Array.isArray(raw.unresolvedInteractionIds)
      ? raw.unresolvedInteractionIds.filter((entry): entry is string => typeof entry === "string")
      : [],
    coverage: isRecord(raw.coverage) ? raw.coverage : null,
    resumeDelta,
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
