import {
  asBoolean,
  asNumber,
  asString,
  asStringArray,
  parseObject,
} from "@paperclipai/adapter-utils/server-utils";
import {
  DEEPSEEK_API_KEY_ENV,
  DEEPSEEK_DEFAULT_BASE_URL,
  DEEPSEEK_REASONING_EFFORTS,
  DEFAULT_DEEPSEEK_MODEL,
  DEFAULT_DEEPSEEK_REASONING_EFFORT,
  type DeepSeekModelPricing,
  type DeepSeekReasoningEffort,
} from "./models.js";

export interface DeepSeekAdapterConfig {
  cwd: string;
  model: string;
  reasoningEffort: DeepSeekReasoningEffort;
  baseUrl: string;
  apiKeyEnvVar: string;
  promptTemplate: string;
  bootstrapPromptTemplate: string;
  instructionsFilePath: string;
  env: Record<string, string>;
  maxTurns: number;
  maxTokens: number | null;
  temperature: number | null;
  topP: number | null;
  stream: boolean;
  strictTools: boolean;
  timeoutSec: number;
  graceSec: number;
  shellTimeoutSec: number;
  shellMaxTimeoutSec: number;
  shell: string;
  exposeApiKeyToShell: boolean;
  maxToolOutputChars: number;
  maxFileReadChars: number;
  disabledTools: string[];
  mcpEnabled: boolean;
  connectionToolsEnabled: boolean;
  compactionThresholdTokens: number;
  compactionKeepRecentMessages: number;
  sessionsDir: string;
  skillsDir: string;
  pricing: Record<string, DeepSeekModelPricing>;
  requestTimeoutSec: number;
  idleTimeoutSec: number;
  maxRetries: number;
}

export const DEEPSEEK_CONFIG_DEFAULTS = {
  maxTurns: 80,
  stream: true,
  strictTools: false,
  timeoutSec: 3600,
  graceSec: 15,
  shellTimeoutSec: 120,
  shellMaxTimeoutSec: 1800,
  maxToolOutputChars: 30_000,
  maxFileReadChars: 100_000,
  mcpEnabled: true,
  connectionToolsEnabled: true,
  compactionThresholdTokens: 240_000,
  compactionKeepRecentMessages: 16,
  requestTimeoutSec: 600,
  idleTimeoutSec: 180,
  maxRetries: 4,
} as const;

/**
 * Resolve the adapter `env` map to plain strings. The Paperclip server resolves
 * secret refs before calling the adapter, so entries arrive either as strings
 * or as `{ type: "plain", value }` objects; anything else is skipped.
 */
export function resolveConfigEnv(value: unknown): Record<string, string> {
  const parsed = parseObject(value);
  const env: Record<string, string> = {};
  for (const [key, entry] of Object.entries(parsed)) {
    if (typeof entry === "string") {
      env[key] = entry;
      continue;
    }
    const record = parseObject(entry);
    if (record.type === "plain" && typeof record.value === "string") {
      env[key] = record.value;
    }
  }
  return env;
}

export function normalizeReasoningEffort(value: unknown): DeepSeekReasoningEffort {
  const raw = asString(value, "").trim().toLowerCase();
  if (!raw) return DEFAULT_DEEPSEEK_REASONING_EFFORT;
  if (raw === "off" || raw === "disabled" || raw === "false") return "none";
  if (raw === "medium") return "high";
  if (raw === "xhigh" || raw === "maximum") return "max";
  return (DEEPSEEK_REASONING_EFFORTS as readonly string[]).includes(raw)
    ? (raw as DeepSeekReasoningEffort)
    : DEFAULT_DEEPSEEK_REASONING_EFFORT;
}

function asOptionalNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asPositiveInt(value: unknown, fallback: number): number {
  const parsed = asOptionalNumber(value);
  if (parsed === null || parsed < 0) return fallback;
  return Math.floor(parsed);
}

function parsePricing(value: unknown): Record<string, DeepSeekModelPricing> {
  const parsed = parseObject(value);
  const out: Record<string, DeepSeekModelPricing> = {};
  for (const [model, entry] of Object.entries(parsed)) {
    const record = parseObject(entry);
    const cacheHit = asOptionalNumber(record.cacheHitPerMTok ?? record.cacheHit ?? record.cachedInput);
    const cacheMiss = asOptionalNumber(record.cacheMissPerMTok ?? record.cacheMiss ?? record.input);
    const output = asOptionalNumber(record.outputPerMTok ?? record.output);
    if (cacheMiss === null || output === null) continue;
    out[model.trim().toLowerCase()] = {
      cacheHitPerMTok: cacheHit ?? cacheMiss,
      cacheMissPerMTok: cacheMiss,
      outputPerMTok: output,
    };
  }
  return out;
}

export function normalizeBaseUrl(value: unknown): string {
  const raw = asString(value, "").trim();
  if (!raw) return DEEPSEEK_DEFAULT_BASE_URL;
  return raw.replace(/\/+$/, "");
}

/**
 * Parse the agent's adapterConfig into a fully defaulted config object. The
 * working directory is resolved separately by execute() because the Paperclip
 * execution workspace can override it per run.
 */
export function parseDeepSeekAdapterConfig(raw: unknown): DeepSeekAdapterConfig {
  const config = parseObject(raw);
  const defaults = DEEPSEEK_CONFIG_DEFAULTS;
  return {
    cwd: asString(config.cwd, "").trim(),
    model: asString(config.model, "").trim() || DEFAULT_DEEPSEEK_MODEL,
    reasoningEffort: normalizeReasoningEffort(config.reasoningEffort ?? config.thinkingEffort ?? config.effort),
    baseUrl: normalizeBaseUrl(config.baseUrl),
    apiKeyEnvVar: asString(config.apiKeyEnvVar, "").trim() || DEEPSEEK_API_KEY_ENV,
    promptTemplate: asString(config.promptTemplate, ""),
    bootstrapPromptTemplate: asString(config.bootstrapPromptTemplate, ""),
    instructionsFilePath: asString(config.instructionsFilePath, "").trim(),
    env: resolveConfigEnv(config.env),
    maxTurns: Math.max(1, asPositiveInt(config.maxTurns, defaults.maxTurns)),
    maxTokens: (() => {
      const value = asOptionalNumber(config.maxTokens);
      return value !== null && value > 0 ? Math.floor(value) : null;
    })(),
    temperature: asOptionalNumber(config.temperature),
    topP: asOptionalNumber(config.topP ?? config.top_p),
    stream: asBoolean(config.stream, defaults.stream),
    strictTools: asBoolean(config.strictTools, defaults.strictTools),
    timeoutSec: asPositiveInt(config.timeoutSec, defaults.timeoutSec),
    graceSec: asPositiveInt(config.graceSec, defaults.graceSec),
    shellTimeoutSec: Math.max(1, asPositiveInt(config.shellTimeoutSec, defaults.shellTimeoutSec)),
    shellMaxTimeoutSec: Math.max(1, asPositiveInt(config.shellMaxTimeoutSec, defaults.shellMaxTimeoutSec)),
    shell: asString(config.shell, "").trim(),
    exposeApiKeyToShell: asBoolean(config.exposeApiKeyToShell, false),
    maxToolOutputChars: Math.max(1000, asPositiveInt(config.maxToolOutputChars, defaults.maxToolOutputChars)),
    maxFileReadChars: Math.max(1000, asPositiveInt(config.maxFileReadChars, defaults.maxFileReadChars)),
    disabledTools: asStringArray(config.disabledTools).map((name) => name.trim()).filter(Boolean),
    mcpEnabled: asBoolean(config.mcpEnabled, defaults.mcpEnabled),
    connectionToolsEnabled: asBoolean(config.connectionToolsEnabled, defaults.connectionToolsEnabled),
    compactionThresholdTokens: asPositiveInt(config.compactionThresholdTokens, defaults.compactionThresholdTokens),
    compactionKeepRecentMessages: Math.max(
      4,
      asPositiveInt(config.compactionKeepRecentMessages, defaults.compactionKeepRecentMessages),
    ),
    sessionsDir: asString(config.sessionsDir, "").trim(),
    skillsDir: asString(config.skillsDir, "").trim(),
    pricing: parsePricing(config.pricing),
    requestTimeoutSec: Math.max(10, asPositiveInt(config.requestTimeoutSec, defaults.requestTimeoutSec)),
    idleTimeoutSec: Math.max(10, asPositiveInt(config.idleTimeoutSec, defaults.idleTimeoutSec)),
    maxRetries: Math.min(10, asPositiveInt(config.maxRetries, defaults.maxRetries)),
  };
}

/**
 * Locate the DeepSeek API key: the agent's resolved env wins, then the server
 * process environment. Returns null when nothing usable is present.
 */
export function resolveDeepSeekApiKey(
  config: Pick<DeepSeekAdapterConfig, "env" | "apiKeyEnvVar">,
  processEnv: NodeJS.ProcessEnv = process.env,
): { apiKey: string; source: "adapter_env" | "process_env" } | null {
  const fromConfig = config.env[config.apiKeyEnvVar]?.trim();
  if (fromConfig) return { apiKey: fromConfig, source: "adapter_env" };
  const fromProcess = processEnv[config.apiKeyEnvVar]?.trim();
  if (fromProcess) return { apiKey: fromProcess, source: "process_env" };
  return null;
}
