/**
 * Conversation persistence between heartbeats.
 *
 * Paperclip stores only a small `sessionParams` blob per task; the full
 * transcript (which can be large) lives on disk in the adapter's sessions
 * directory. The transcript file is the source of truth for resuming a
 * conversation, so it is written atomically after every run.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { resolvePaperclipInstanceRootForAdapter } from "@paperclipai/adapter-utils/server-utils";
import type { DeepSeekMessage } from "./deepseek-client.js";
import type { DeepSeekUsageSnapshot } from "./events.js";
import { emptyUsage } from "./events.js";

export const SESSION_FILE_VERSION = 1;

export interface DeepSeekSessionFile {
  version: number;
  sessionId: string;
  adapterType: string;
  agentId: string;
  companyId: string;
  cwd: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  runs: number;
  lastRunId: string | null;
  /** Prompt tokens observed on the last API call; drives compaction. */
  lastPromptTokens: number;
  usageTotals: DeepSeekUsageSnapshot;
  messages: DeepSeekMessage[];
}

export interface DeepSeekSessionParams {
  sessionId: string;
  cwd: string;
  model: string;
  transcriptPath: string;
  messageCount: number;
  updatedAt: string;
  [key: string]: unknown;
}

export function defaultSessionsDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolvePaperclipInstanceRootForAdapter({ env }), "adapters", "deepseek_api", "sessions");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function readSessionParams(raw: unknown): DeepSeekSessionParams | null {
  if (!isRecord(raw)) return null;
  const sessionId = readString(raw.sessionId) ?? readString(raw.session_id);
  if (!sessionId) return null;
  return {
    sessionId,
    cwd: readString(raw.cwd) ?? "",
    model: readString(raw.model) ?? "",
    transcriptPath: readString(raw.transcriptPath) ?? "",
    messageCount: typeof raw.messageCount === "number" && Number.isFinite(raw.messageCount) ? raw.messageCount : 0,
    updatedAt: readString(raw.updatedAt) ?? "",
  };
}

export function isValidMessage(value: unknown): value is DeepSeekMessage {
  if (!isRecord(value)) return false;
  const role = value.role;
  if (role === "system" || role === "user") return typeof value.content === "string";
  if (role === "tool") return typeof value.tool_call_id === "string" && typeof value.content === "string";
  if (role === "assistant") {
    if (value.content !== null && value.content !== undefined && typeof value.content !== "string") return false;
    if (value.tool_calls !== undefined && !Array.isArray(value.tool_calls)) return false;
    return true;
  }
  return false;
}

export class DeepSeekSessionStore {
  constructor(readonly directory: string) {}

  transcriptPath(sessionId: string): string {
    const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
    return path.join(this.directory, `${safe}.json`);
  }

  create(input: {
    agentId: string;
    companyId: string;
    cwd: string;
    model: string;
    adapterType: string;
  }): DeepSeekSessionFile {
    const now = new Date().toISOString();
    return {
      version: SESSION_FILE_VERSION,
      sessionId: `ds_${randomUUID()}`,
      adapterType: input.adapterType,
      agentId: input.agentId,
      companyId: input.companyId,
      cwd: input.cwd,
      model: input.model,
      createdAt: now,
      updatedAt: now,
      runs: 0,
      lastRunId: null,
      lastPromptTokens: 0,
      usageTotals: emptyUsage(),
      messages: [],
    };
  }

  async load(sessionId: string, explicitPath?: string): Promise<DeepSeekSessionFile | null> {
    const candidates = [explicitPath, this.transcriptPath(sessionId)].filter(
      (entry): entry is string => typeof entry === "string" && entry.length > 0,
    );
    for (const candidate of candidates) {
      let raw: string;
      try {
        raw = await fs.readFile(candidate, "utf8");
      } catch {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        continue;
      }
      if (!isRecord(parsed) || parsed.version !== SESSION_FILE_VERSION) continue;
      const messages = Array.isArray(parsed.messages) ? parsed.messages.filter(isValidMessage) : [];
      return {
        version: SESSION_FILE_VERSION,
        sessionId: readString(parsed.sessionId) ?? sessionId,
        adapterType: readString(parsed.adapterType) ?? "deepseek_api",
        agentId: readString(parsed.agentId) ?? "",
        companyId: readString(parsed.companyId) ?? "",
        cwd: readString(parsed.cwd) ?? "",
        model: readString(parsed.model) ?? "",
        createdAt: readString(parsed.createdAt) ?? new Date().toISOString(),
        updatedAt: readString(parsed.updatedAt) ?? new Date().toISOString(),
        runs: typeof parsed.runs === "number" ? parsed.runs : 0,
        lastRunId: readString(parsed.lastRunId),
        lastPromptTokens: typeof parsed.lastPromptTokens === "number" ? parsed.lastPromptTokens : 0,
        usageTotals: isRecord(parsed.usageTotals)
          ? {
              promptTokens: Number(parsed.usageTotals.promptTokens) || 0,
              cacheHitTokens: Number(parsed.usageTotals.cacheHitTokens) || 0,
              cacheMissTokens: Number(parsed.usageTotals.cacheMissTokens) || 0,
              completionTokens: Number(parsed.usageTotals.completionTokens) || 0,
              reasoningTokens: Number(parsed.usageTotals.reasoningTokens) || 0,
            }
          : emptyUsage(),
        messages,
      };
    }
    return null;
  }

  async save(session: DeepSeekSessionFile): Promise<string> {
    await fs.mkdir(this.directory, { recursive: true });
    const target = this.transcriptPath(session.sessionId);
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    session.updatedAt = new Date().toISOString();
    const payload = JSON.stringify(session, null, 1);
    await fs.writeFile(tmp, payload, "utf8");
    await fs.rename(tmp, target);
    return target;
  }

  toSessionParams(session: DeepSeekSessionFile): DeepSeekSessionParams {
    return {
      sessionId: session.sessionId,
      cwd: session.cwd,
      model: session.model,
      transcriptPath: this.transcriptPath(session.sessionId),
      messageCount: session.messages.length,
      updatedAt: session.updatedAt,
    };
  }
}
