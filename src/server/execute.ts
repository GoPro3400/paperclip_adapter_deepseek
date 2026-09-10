/**
 * Heartbeat execution for the deepseek_api adapter.
 *
 * Paperclip calls execute() once per wake. The adapter resolves configuration,
 * credentials and the working directory, restores the previous conversation
 * (when the cwd matches), assembles the system prompt and the per-run user
 * prompt, runs the DeepSeek tool-calling loop, persists the transcript and
 * reports usage, cost and a summary back to Paperclip.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  AdapterInvocationMeta,
} from "@paperclipai/adapter-utils";
import {
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  applyPaperclipWorkspaceEnv,
  asString,
  buildPaperclipEnv,
  ensureAbsoluteDirectory,
  isPaperclipRecoveryWakePayload,
  joinPromptSections,
  parseObject,
  readPaperclipIssueWorkModeFromContext,
  redactEnvForLogs,
  renderPaperclipWakePrompt,
  renderTemplate,
  selectPaperclipTaskMarkdown,
  stringifyPaperclipWakePayload,
} from "@paperclipai/adapter-utils/server-utils";
import { type } from "../index.js";
import { runAgentLoop, type AgentLoopResult } from "./agent-loop.js";
import { buildRuntimeToolsEnv, readRuntimeToolAccess, type ExecutionErrorFamily, type ExtendedExecutionContext } from "./compat.js";
import { parseDeepSeekAdapterConfig, resolveDeepSeekApiKey, type DeepSeekAdapterConfig } from "./config.js";
import { DeepSeekClient } from "./deepseek-client.js";
import { eventLine, type DeepSeekRunEvent } from "./events.js";
import { pricingForModel } from "./pricing.js";
import { buildSystemPrompt, renderHeartbeatFacts } from "./prompt.js";
import { DeepSeekSessionStore, defaultSessionsDir, readSessionParams, type DeepSeekSessionFile } from "./session-store.js";
import { SecretRedactor, errorMessage, estimateTokens, truncateMiddle } from "./text.js";
import { createConnectionTools } from "./tools/connections.js";
import { createFileTools } from "./tools/files.js";
import { FINISH_RUN_TOOL_NAME, createFinishRunTool } from "./tools/finish.js";
import { createMcpTools } from "./tools/mcp.js";
import { createPaperclipApiTool } from "./tools/paperclip-api.js";
import { ToolRegistry, type ToolRuntime } from "./tools/registry.js";
import { createShellTool } from "./tools/shell.js";
import { buildSkillCatalog, createLoadSkillTool } from "./tools/skills.js";

export interface ExecuteDeps {
  fetchImpl?: typeof fetch;
  processEnv?: NodeJS.ProcessEnv;
  moduleDir?: string;
  /** Base backoff delay for API retries (tests lower it). */
  retryBaseDelayMs?: number;
}

const PROVIDER = "deepseek";

function trimmed(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function failureResult(input: {
  message: string;
  code: string;
  family?: ExecutionErrorFamily | null;
  model?: string | null;
  sessionParams?: Record<string, unknown> | null;
}): AdapterExecutionResult {
  return {
    exitCode: 1,
    signal: null,
    timedOut: false,
    errorMessage: input.message,
    errorCode: input.code,
    errorFamily: input.family ?? null,
    provider: PROVIDER,
    biller: PROVIDER,
    billingType: "api",
    model: input.model ?? null,
    sessionParams: input.sessionParams ?? null,
    clearSession: false,
  };
}

function errorFamilyForKind(kind: string | null): ExecutionErrorFamily | null {
  switch (kind) {
    case "insufficient_balance":
      return "provider_quota";
    case "rate_limited":
    case "server_error":
    case "network":
    case "timeout":
      return "transient_upstream";
    default:
      return null;
  }
}

function errorCodeForKind(kind: string | null): string {
  switch (kind) {
    case "auth":
      return "deepseek_auth_failed";
    case "insufficient_balance":
      return "deepseek_insufficient_balance";
    case "rate_limited":
      return "deepseek_rate_limited";
    case "invalid_request":
      return "deepseek_invalid_request";
    case "timeout":
      return "deepseek_request_timeout";
    case "network":
      return "deepseek_network_error";
    default:
      return "deepseek_api_error";
  }
}

async function readInstructions(
  filePath: string,
  cwd: string,
  warn: (message: string) => Promise<void>,
): Promise<{ text: string; path: string } | null> {
  if (!filePath) return null;
  const resolved = path.resolve(cwd, filePath);
  try {
    const text = await fs.readFile(resolved, "utf8");
    return text.trim() ? { text, path: resolved } : null;
  } catch (err) {
    await warn(`Could not read instructions file "${resolved}": ${errorMessage(err)}`);
    return null;
  }
}

export async function executeWith(rawCtx: AdapterExecutionContext, deps: ExecuteDeps = {}): Promise<AdapterExecutionResult> {
  const ctx = rawCtx as ExtendedExecutionContext;
  const runtimeTools = readRuntimeToolAccess(rawCtx);
  const { runId, agent, runtime, context, onLog, onMeta } = ctx;
  const processEnv = deps.processEnv ?? process.env;
  const config = parseDeepSeekAdapterConfig(ctx.config);
  const moduleDir = deps.moduleDir ?? path.dirname(fileURLToPath(import.meta.url));
  const startedAt = new Date();

  // Every line written to the run log passes through the redactor so a model
  // that echoes a credential (in a tool argument, a prompt, or its own text)
  // never leaks it into transcripts. Secrets are registered as they become
  // known below.
  const redactor = new SecretRedactor();
  const redact = (text: string) => redactor.redact(text);
  const emit = async (event: DeepSeekRunEvent) => {
    await onLog("stdout", redact(eventLine(event)));
  };
  const warn = async (message: string) => {
    await emit({ type: "deepseek.warning", message });
  };

  if (ctx.executionTarget && ctx.executionTarget.kind !== "local") {
    return failureResult({
      message: `deepseek_api runs on the Paperclip host only; execution target "${ctx.executionTarget.kind}" is not supported.`,
      code: "deepseek_remote_target_unsupported",
      model: config.model,
    });
  }

  const keyInfo = resolveDeepSeekApiKey(config, processEnv);
  if (!keyInfo) {
    return failureResult({
      message: `${config.apiKeyEnvVar} is not configured. Add it to the agent environment variables or the Paperclip server environment.`,
      code: "deepseek_api_key_missing",
      model: config.model,
    });
  }

  // ---------------------------------------------------------------------
  // Working directory
  // ---------------------------------------------------------------------
  const workspace = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspace.cwd, "");
  const workspaceSource = asString(workspace.source, "");
  const useConfiguredInsteadOfAgentHome = workspaceSource === "agent_home" && config.cwd.length > 0;
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome ? "" : workspaceCwd;
  const cwd = effectiveWorkspaceCwd || config.cwd || process.cwd();
  try {
    await ensureAbsoluteDirectory(cwd, { createIfMissing: true });
  } catch (err) {
    return failureResult({ message: errorMessage(err), code: "deepseek_invalid_cwd", model: config.model });
  }

  // ---------------------------------------------------------------------
  // Environment for tools (shell + scripts) and secret redaction
  // ---------------------------------------------------------------------
  const runEnv: Record<string, string> = { ...buildPaperclipEnv(agent), PAPERCLIP_RUN_ID: runId };
  const wakeTaskId = trimmed(context.taskId) ?? trimmed(context.issueId);
  const wakeReason = trimmed(context.wakeReason);
  const wakeCommentId = trimmed(context.wakeCommentId) ?? trimmed(context.commentId);
  const approvalId = trimmed(context.approvalId);
  const approvalStatus = trimmed(context.approvalStatus);
  const linkedIssueIds = Array.isArray(context.issueIds)
    ? context.issueIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  if (wakeTaskId) runEnv.PAPERCLIP_TASK_ID = wakeTaskId;
  if (wakeReason) runEnv.PAPERCLIP_WAKE_REASON = wakeReason;
  if (wakeCommentId) runEnv.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
  if (approvalId) runEnv.PAPERCLIP_APPROVAL_ID = approvalId;
  if (approvalStatus) runEnv.PAPERCLIP_APPROVAL_STATUS = approvalStatus;
  if (linkedIssueIds.length > 0) runEnv.PAPERCLIP_LINKED_ISSUE_IDS = linkedIssueIds.join(",");
  const wakePayloadJson = stringifyPaperclipWakePayload(context.paperclipWake);
  if (wakePayloadJson) runEnv.PAPERCLIP_WAKE_PAYLOAD_JSON = wakePayloadJson;
  const issueWorkMode = readPaperclipIssueWorkModeFromContext(context);
  if (issueWorkMode) runEnv.PAPERCLIP_ISSUE_WORK_MODE = issueWorkMode;
  applyPaperclipWorkspaceEnv(runEnv, {
    workspaceCwd: effectiveWorkspaceCwd || null,
    workspaceSource: workspaceSource || null,
    workspaceStrategy: asString(workspace.strategy, "") || null,
    workspaceId: asString(workspace.workspaceId, "") || null,
    workspaceRepoUrl: asString(workspace.repoUrl, "") || null,
    workspaceRepoRef: asString(workspace.repoRef, "") || null,
    workspaceBranch: asString(workspace.branchName, "") || null,
    workspaceWorktreePath: asString(workspace.worktreePath, "") || null,
    agentHome: asString(workspace.agentHome, "") || null,
  });
  Object.assign(runEnv, buildRuntimeToolsEnv(runtimeTools));

  const scratchRoot = path.join(os.tmpdir(), "paperclip-deepseek", runId.replace(/[^a-zA-Z0-9_-]/g, "_"));
  try {
    await fs.mkdir(scratchRoot, { recursive: true });
    runEnv.PAPERCLIP_RUN_SCRATCH_DIR = scratchRoot;
    if (!runEnv.PAPERCLIP_SCRATCH_DIR) runEnv.PAPERCLIP_SCRATCH_DIR = scratchRoot;
  } catch {
    // Scratch space is best effort.
  }

  const paperclipApiKey = trimmed(ctx.authToken) ?? trimmed(config.env.PAPERCLIP_API_KEY);
  for (const [key, value] of Object.entries(config.env)) {
    if (key === "PAPERCLIP_API_KEY") continue;
    if (key === config.apiKeyEnvVar && !config.exposeApiKeyToShell) continue;
    if (key.startsWith("PAPERCLIP_") && key in runEnv) continue;
    runEnv[key] = value;
  }
  if (paperclipApiKey) runEnv.PAPERCLIP_API_KEY = paperclipApiKey;

  redactor.add(keyInfo.apiKey);
  redactor.add(paperclipApiKey);
  redactor.add(runtimeTools?.bearerToken);
  redactor.addFromEnv(config.env);
  const mcpServers = ctx.runtimeMcp?.getServers() ?? [];
  for (const server of mcpServers) redactor.add(server.token);
  const safeLog = async (message: string) => {
    await onLog("stdout", `[paperclip] ${redact(message)}\n`);
  };

  // ---------------------------------------------------------------------
  // Session resume
  // ---------------------------------------------------------------------
  const sessionsDir = config.sessionsDir || defaultSessionsDir(processEnv);
  const store = new DeepSeekSessionStore(sessionsDir);
  const previous = readSessionParams(runtime.sessionParams) ??
    (trimmed(runtime.sessionId)
      ? { sessionId: runtime.sessionId!.trim(), cwd: "", model: "", transcriptPath: "", messageCount: 0, updatedAt: "" }
      : null);
  let session: DeepSeekSessionFile | null = null;
  let resumed = false;
  const sessionNotes: string[] = [];
  if (previous) {
    const cwdMatches = !previous.cwd || path.resolve(previous.cwd) === path.resolve(cwd);
    if (!cwdMatches) {
      sessionNotes.push(`Saved session ${previous.sessionId} belongs to cwd "${previous.cwd}"; starting a fresh session in "${cwd}".`);
    } else {
      const loaded = await store.load(previous.sessionId, previous.transcriptPath || undefined);
      if (!loaded) {
        sessionNotes.push(`Transcript for session ${previous.sessionId} was not found under ${sessionsDir}; starting a fresh session.`);
      } else if (loaded.cwd && path.resolve(loaded.cwd) !== path.resolve(cwd)) {
        sessionNotes.push(`Transcript for session ${previous.sessionId} was recorded in "${loaded.cwd}"; starting a fresh session in "${cwd}".`);
      } else {
        session = loaded;
        resumed = loaded.messages.length > 0;
        if (loaded.model && loaded.model !== config.model) {
          sessionNotes.push(`Session ${previous.sessionId} was created with model ${loaded.model}; continuing with ${config.model}.`);
        }
      }
    }
  }
  if (!session) {
    session = store.create({ agentId: agent.id, companyId: agent.companyId, cwd, model: config.model, adapterType: type });
  }
  session.model = config.model;
  session.cwd = cwd;

  // ---------------------------------------------------------------------
  // Tools
  // ---------------------------------------------------------------------
  const skills = await buildSkillCatalog({ config: ctx.config, moduleDir, extraSkillsDir: config.skillsDir || undefined });
  const registry = new ToolRegistry({ strict: config.strictTools });
  const disabled = new Set(config.disabledTools.filter((name) => name !== FINISH_RUN_TOOL_NAME));
  const paperclipApiUrl = trimmed(runEnv.PAPERCLIP_API_URL);
  const paperclipApiAvailable = Boolean(paperclipApiUrl && paperclipApiKey);
  const toolNotes: string[] = [];
  const registerIfEnabled = (tool: ReturnType<typeof createFinishRunTool>) => {
    if (disabled.has(tool.name)) {
      toolNotes.push(`Tool ${tool.name} disabled by configuration.`);
      return;
    }
    registry.register(tool);
  };

  if (paperclipApiAvailable && paperclipApiUrl && paperclipApiKey) {
    registerIfEnabled(
      createPaperclipApiTool({
        apiUrl: paperclipApiUrl,
        apiKey: paperclipApiKey,
        runId,
        agentId: agent.id,
        companyId: agent.companyId,
        fetchImpl: deps.fetchImpl,
      }),
    );
  } else {
    toolNotes.push("Paperclip API tool unavailable: no run token or API URL was provided.");
  }
  registerIfEnabled(
    createShellTool({
      env: runEnv,
      defaultTimeoutSec: config.shellTimeoutSec,
      maxTimeoutSec: config.shellMaxTimeoutSec,
      graceSec: config.graceSec,
      shell: config.shell || undefined,
    }),
  );
  for (const tool of createFileTools({ maxFileReadChars: config.maxFileReadChars })) registerIfEnabled(tool);
  if (skills.length > 0) registerIfEnabled(createLoadSkillTool(skills, config.maxFileReadChars));
  registry.register(createFinishRunTool());
  if (runtimeTools && config.connectionToolsEnabled) {
    for (const tool of createConnectionTools(runtimeTools, deps.fetchImpl)) registerIfEnabled(tool);
  }

  // ---------------------------------------------------------------------
  // Cancellation, deadline
  // ---------------------------------------------------------------------
  const controller = new AbortController();
  const onCtxAbort = () => controller.abort(ctx.signal?.reason instanceof Error ? ctx.signal.reason : new Error("cancelled"));
  if (ctx.signal?.aborted) onCtxAbort();
  ctx.signal?.addEventListener("abort", onCtxAbort, { once: true });
  const deadlineAt = config.timeoutSec > 0 ? Date.now() + config.timeoutSec * 1000 : null;
  const deadlineTimer = deadlineAt
    ? setTimeout(() => controller.abort(new Error("timeout")), Math.max(0, deadlineAt - Date.now()))
    : null;

  try {
    if (ctx.runtimeMcp && config.mcpEnabled && mcpServers.length > 0) {
      const mcpTools = await createMcpTools({
        servers: mcpServers,
        fetchImpl: deps.fetchImpl,
        signal: controller.signal,
        onWarning: warn,
        reservedNames: new Set(registry.names()),
      });
      for (const tool of mcpTools) registerIfEnabled(tool);
      if (mcpTools.length > 0) toolNotes.push(`Exposed ${mcpTools.length} MCP tool(s) from ${mcpServers.length} server(s).`);
    }

    // -------------------------------------------------------------------
    // Prompts
    // -------------------------------------------------------------------
    const instructions = await readInstructions(config.instructionsFilePath, cwd, warn);
    const systemPrompt = buildSystemPrompt({
      agent: { id: agent.id, name: agent.name, companyId: agent.companyId },
      instructions,
      cwd,
      workspace: {
        source: workspaceSource || null,
        branch: asString(workspace.branchName, "") || null,
        repoUrl: asString(workspace.repoUrl, "") || null,
        worktreePath: asString(workspace.worktreePath, "") || null,
      },
      tools: registry.list(),
      skills,
      paperclipApiUrl,
      paperclipApiAvailable,
      shellEnvKeys: Object.keys(runEnv).filter((key) => key.startsWith("PAPERCLIP_")).sort(),
      runtimeToolsGuidance: runtimeTools && config.connectionToolsEnabled ? runtimeTools.guidance : null,
      model: config.model,
      reasoningEffort: config.reasoningEffort,
    });

    const promptTemplate = config.promptTemplate || DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE;
    const templateData = {
      agentId: agent.id,
      companyId: agent.companyId,
      runId,
      company: { id: agent.companyId },
      agent,
      run: { id: runId, source: "on_demand" },
      context,
    };
    const renderedBootstrapPrompt =
      !resumed && config.bootstrapPromptTemplate.trim().length > 0
        ? renderTemplate(config.bootstrapPromptTemplate, templateData).trim()
        : "";
    const taskContextNote = selectPaperclipTaskMarkdown(context, { resumedSession: resumed });
    const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake, {
      resumedSession: resumed,
      suppressIssueDescription: taskContextNote.length > 0,
    });
    const useResumeDelta = resumed && wakePrompt.length > 0;
    const renderedPrompt = useResumeDelta || isPaperclipRecoveryWakePayload(context.paperclipWake)
      ? ""
      : renderTemplate(promptTemplate, templateData);
    const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();
    const heartbeatFacts = renderHeartbeatFacts({
      runId,
      startedAt: startedAt.toISOString(),
      agentId: agent.id,
      taskId: wakeTaskId,
      wakeReason,
      wakeCommentId,
      approvalId,
      approvalStatus,
      linkedIssueIds,
      resumedSession: resumed,
      sessionRuns: session.runs,
    });
    const userPrompt = joinPromptSections([
      renderedBootstrapPrompt,
      wakePrompt,
      sessionHandoffNote,
      taskContextNote,
      renderedPrompt,
      heartbeatFacts,
    ]);

    const commandNotes = [
      `DeepSeek model ${config.model}, reasoning effort ${config.reasoningEffort}, ${config.stream ? "streaming" : "non-streaming"}${config.strictTools ? ", strict tools (beta endpoint)" : ""}.`,
      resumed
        ? `Resumed session ${session.sessionId} with ${session.messages.length} stored messages (${session.runs} earlier runs).`
        : `Started fresh session ${session.sessionId}.`,
      ...sessionNotes,
      ...toolNotes,
      `Tools: ${registry.names().join(", ")}.`,
      instructions ? `Loaded agent instructions from ${instructions.path}.` : "No instructions file configured.",
      `API key source: ${keyInfo.source === "adapter_env" ? "agent environment" : "server process environment"}.`,
    ];
    for (const note of sessionNotes) await safeLog(note);

    if (onMeta) {
      const meta: AdapterInvocationMeta = {
        adapterType: type,
        command: `deepseek-api:${config.model}`,
        cwd,
        commandNotes,
        env: redactEnvForLogs(runEnv),
        prompt: userPrompt,
        promptMetrics: {
          promptChars: userPrompt.length,
          systemPromptChars: systemPrompt.length,
          bootstrapPromptChars: renderedBootstrapPrompt.length,
          wakePromptChars: wakePrompt.length,
          sessionHandoffChars: sessionHandoffNote.length,
          taskContextChars: taskContextNote.length,
          heartbeatPromptChars: renderedPrompt.length,
          historyMessages: session.messages.length,
          toolCount: registry.size,
        },
        context: {
          deepseek: {
            baseUrl: config.baseUrl,
            model: config.model,
            reasoningEffort: config.reasoningEffort,
            sessionId: session.sessionId,
            resumed,
            transcriptPath: store.transcriptPath(session.sessionId),
          },
        },
      };
      await onMeta(meta);
    }

    const client = new DeepSeekClient({
      apiKey: keyInfo.apiKey,
      baseUrl: config.baseUrl,
      fetchImpl: deps.fetchImpl,
      requestTimeoutMs: config.requestTimeoutSec * 1000,
      idleTimeoutMs: config.idleTimeoutSec * 1000,
      maxRetries: config.maxRetries,
      retryBaseDelayMs: deps.retryBaseDelayMs,
      onRetry: async ({ attempt, delayMs, error }) => {
        await warn(`DeepSeek request failed (${error.message}); retry ${attempt}/${config.maxRetries} in ${Math.round(delayMs / 1000)}s.`);
      },
    });

    const toolRuntime: ToolRuntime = {
      cwd,
      signal: controller.signal,
      maxOutputChars: config.maxToolOutputChars,
      redact,
      log: safeLog,
    };

    await ctx.onCancellationReady?.();
    ctx.onDispatch?.();
    await emit({
      type: "deepseek.init",
      sessionId: session.sessionId,
      model: config.model,
      resumed,
      reasoningEffort: config.reasoningEffort,
      baseUrl: config.baseUrl,
      toolNames: registry.names(),
      historyMessages: session.messages.length,
    });

    const pricing = pricingForModel(config.model, config.pricing);
    let loop: AgentLoopResult;
    try {
      loop = await runAgentLoop({
        client,
        model: config.model,
        reasoningEffort: config.reasoningEffort,
        maxTokens: config.maxTokens,
        temperature: config.temperature,
        topP: config.topP,
        stream: config.stream,
        strictTools: config.strictTools,
        systemPrompt,
        history: session.messages,
        userPrompt,
        tools: registry,
        toolRuntime,
        maxTurns: config.maxTurns,
        emit,
        signal: controller.signal,
        deadlineAt,
        compaction: {
          thresholdTokens: config.compactionThresholdTokens,
          keepRecentMessages: config.compactionKeepRecentMessages,
          initialPromptTokens: session.lastPromptTokens || estimateTokens(systemPrompt) + estimateTokens(JSON.stringify(session.messages)),
        },
        pricing,
      });
    } catch (err) {
      const message = errorMessage(err);
      await emit({ type: "deepseek.error", message: redact(message) });
      return failureResult({ message: redact(message), code: "deepseek_loop_failed", model: config.model, sessionParams: store.toSessionParams(session) });
    }

    // -------------------------------------------------------------------
    // Persist the transcript
    // -------------------------------------------------------------------
    session.messages = loop.messages;
    session.runs += 1;
    session.lastRunId = runId;
    session.lastPromptTokens = loop.lastPromptTokens;
    session.usageTotals = {
      promptTokens: session.usageTotals.promptTokens + loop.usage.promptTokens,
      cacheHitTokens: session.usageTotals.cacheHitTokens + loop.usage.cacheHitTokens,
      cacheMissTokens: session.usageTotals.cacheMissTokens + loop.usage.cacheMissTokens,
      completionTokens: session.usageTotals.completionTokens + loop.usage.completionTokens,
      reasoningTokens: session.usageTotals.reasoningTokens + loop.usage.reasoningTokens,
    };
    let transcriptPath: string | null = null;
    try {
      transcriptPath = await store.save(session);
    } catch (err) {
      await warn(`Could not persist the session transcript: ${errorMessage(err)}. The next heartbeat will start a fresh conversation.`);
    }

    const status: "completed" | "error" | "timeout" | "cancelled" =
      loop.stopReason === "error" ? "error" : loop.stopReason === "timeout" ? "timeout" : loop.stopReason === "cancelled" ? "cancelled" : "completed";
    const summarySource = loop.finish?.summary || loop.finalText || "";
    const summary = summarySource ? truncateMiddle(redact(summarySource), 4000).text : null;
    const errors = loop.error ? [loop.error.message] : [];
    await emit({
      type: "deepseek.result",
      status,
      stopReason: loop.stopReason,
      summary: summary ?? "",
      disposition: loop.finish?.disposition ?? null,
      turns: loop.turns,
      usage: loop.usage,
      costUsd: loop.costUsd,
      sessionId: session.sessionId,
      errors,
    });

    const sessionParams = transcriptPath ? store.toSessionParams(session) : null;
    const base: AdapterExecutionResult = {
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      usage: {
        inputTokens: loop.usage.cacheMissTokens,
        cachedInputTokens: loop.usage.cacheHitTokens,
        outputTokens: loop.usage.completionTokens,
      },
      usageBasis: "per_run",
      sessionId: session.sessionId,
      sessionDisplayId: session.sessionId,
      sessionParams,
      provider: PROVIDER,
      biller: PROVIDER,
      billingType: "api",
      model: config.model,
      costUsd: loop.costUsd,
      cacheAdjustedCostUsd: loop.costUsd,
      summary,
      clearSession: false,
      resultJson: {
        stopReason: loop.stopReason,
        disposition: loop.finish?.disposition ?? null,
        finish: loop.finish,
        turns: loop.turns,
        toolCalls: loop.toolCalls,
        toolErrors: loop.toolErrors,
        compactions: loop.compactions,
        reasoningPolicy: loop.reasoningPolicy,
        finishReasons: loop.finishReasons,
        usage: loop.usage,
        costUsd: loop.costUsd,
        pricingApplied: pricing,
        model: config.model,
        reasoningEffort: config.reasoningEffort,
        sessionId: session.sessionId,
        transcriptPath,
        resumed,
        durationMs: Date.now() - startedAt.getTime(),
        ...(loop.error ? { error: loop.error } : {}),
      },
    };

    if (loop.stopReason === "timeout") {
      return { ...base, exitCode: null, timedOut: true, errorMessage: `Timed out after ${config.timeoutSec}s` };
    }
    if (loop.stopReason === "cancelled") {
      return { ...base, exitCode: null, signal: "SIGTERM", errorMessage: "Run cancelled" };
    }
    if (loop.stopReason === "error" && loop.error) {
      const retryNotBefore = loop.error.kind === "rate_limited" ? new Date(Date.now() + 60_000).toISOString() : null;
      return {
        ...base,
        exitCode: 1,
        errorMessage: redact(loop.error.message),
        errorCode: errorCodeForKind(loop.error.kind),
        errorFamily: errorFamilyForKind(loop.error.kind),
        ...(retryNotBefore ? { retryNotBefore } : {}),
      };
    }
    if (loop.stopReason === "max_turns") {
      return {
        ...base,
        resultJson: { ...base.resultJson, warning: `Turn limit (${config.maxTurns}) reached before the model finished.` },
      };
    }
    return base;
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    ctx.signal?.removeEventListener("abort", onCtxAbort);
    await fs.rm(scratchRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  return executeWith(ctx);
}

export type { DeepSeekAdapterConfig };
