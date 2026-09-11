/**
 * Server entry: builds the ServerAdapterModule consumed by Paperclip's plugin
 * loader (`createServerAdapter`) and re-exports the pieces built-in
 * registrations or tests may want.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AdapterConfigSchema,
  AdapterModel,
  AdapterSessionCodec,
  AdapterSessionManagement,
  AdapterSkillContext,
  AdapterSkillEntry,
  AdapterSkillSnapshot,
  ServerAdapterModule,
} from "@paperclipai/adapter-utils";
import {
  buildRuntimeMountedSkillSnapshot,
  readPaperclipRuntimeSkillEntries,
  resolvePaperclipDesiredSkillNames,
} from "@paperclipai/adapter-utils/server-utils";
import { agentConfigurationDoc, label, models, type } from "../index.js";
import { DEEPSEEK_CONFIG_DEFAULTS, parseDeepSeekAdapterConfig, resolveDeepSeekApiKey } from "./config.js";
import { DeepSeekClient } from "./deepseek-client.js";
import { execute } from "./execute.js";
import {
  DEEPSEEK_API_KEY_ENV,
  DEEPSEEK_DEFAULT_BASE_URL,
  DEEPSEEK_MODEL_CATALOG,
  DEFAULT_DEEPSEEK_MODEL,
  DEFAULT_DEEPSEEK_REASONING_EFFORT,
} from "./models.js";
import { readSessionParams } from "./session-store.js";
import { testEnvironment } from "./test.js";
import { buildSkillCatalog } from "./tools/skills.js";

export { execute, executeWith } from "./execute.js";
export { testEnvironment, testEnvironmentWith } from "./test.js";
export { parseDeepSeekAdapterConfig, resolveDeepSeekApiKey } from "./config.js";
export { DeepSeekClient, DeepSeekApiError } from "./deepseek-client.js";
export { runAgentLoop } from "./agent-loop.js";
export { ToolRegistry } from "./tools/registry.js";

export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw: unknown) {
    const params = readSessionParams(raw);
    return params ? { ...params } : null;
  },
  serialize(params: Record<string, unknown> | null) {
    const parsed = readSessionParams(params);
    return parsed ? { ...parsed } : null;
  },
  getDisplayId(params: Record<string, unknown> | null) {
    return readSessionParams(params)?.sessionId ?? null;
  },
};

/**
 * The adapter compacts its own context (summaries above a token threshold),
 * so Paperclip should not rotate sessions on raw-token thresholds.
 */
export const sessionManagement: AdapterSessionManagement = {
  supportsSessionResume: true,
  nativeContextManagement: "confirmed",
  defaultSessionCompaction: {
    enabled: true,
    maxSessionRuns: 0,
    maxRawInputTokens: 0,
    maxSessionAgeHours: 0,
  },
};

const MODEL_CACHE_TTL_MS = 10 * 60 * 1000;
let cachedModels: { at: number; models: AdapterModel[] } | null = null;

function catalogModels(): AdapterModel[] {
  return DEEPSEEK_MODEL_CATALOG.map((model) => ({ id: model.id, label: model.label }));
}

/**
 * Model discovery for the agent form. When the server process carries a
 * DeepSeek key, the live /models list is merged with the catalog so newly
 * released ids show up without a package update.
 */
export async function discoverModels(options: { force?: boolean; fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv } = {}): Promise<AdapterModel[]> {
  const env = options.env ?? process.env;
  const apiKey = env[DEEPSEEK_API_KEY_ENV]?.trim();
  if (!apiKey) return catalogModels();
  if (!options.force && cachedModels && Date.now() - cachedModels.at < MODEL_CACHE_TTL_MS) return cachedModels.models;
  try {
    const client = new DeepSeekClient({
      apiKey,
      baseUrl: env.DEEPSEEK_BASE_URL?.trim() || DEEPSEEK_DEFAULT_BASE_URL,
      fetchImpl: options.fetchImpl,
      requestTimeoutMs: 15_000,
      idleTimeoutMs: 15_000,
      maxRetries: 1,
    });
    const live = await client.listModels();
    const byId = new Map<string, AdapterModel>();
    for (const model of catalogModels()) byId.set(model.id, model);
    for (const id of live) {
      if (!byId.has(id)) byId.set(id, { id, label: id });
    }
    const merged = [...byId.values()];
    cachedModels = { at: Date.now(), models: merged };
    return merged;
  } catch {
    return cachedModels?.models ?? catalogModels();
  }
}

export function resetModelCacheForTests(): void {
  cachedModels = null;
}

/**
 * Declarative form fields. `model` is deliberately absent: the agent form
 * renders its own model dropdown (fed by listModels/refreshModels) and its own
 * "Thinking effort" control, and schema defaults are merged over those core
 * values on create, so a schema `model` default would overwrite the operator's
 * choice. `reasoningEffort` stays as the DeepSeek-specific override (it adds
 * none/max) with an empty default so it only takes effect when set.
 */
export function getConfigSchema(): AdapterConfigSchema {
  return {
    fields: [
      {
        key: "reasoningEffort",
        label: "DeepSeek reasoning effort",
        type: "select",
        default: "",
        options: [
          { value: "", label: `Use the Thinking effort setting (default ${DEFAULT_DEEPSEEK_REASONING_EFFORT})` },
          { value: "none", label: "None (thinking disabled)" },
          { value: "low", label: "Low" },
          { value: "high", label: "High (recommended for agent work)" },
          { value: "max", label: "Max (deepest reasoning, slowest)" },
        ],
        hint: "Overrides the Thinking effort control (medium counts as high). Only this field offers none and max. DeepSeek ignores temperature/top_p while thinking is enabled.",
      },
      {
        key: "baseUrl",
        label: "API base URL",
        type: "text",
        default: DEEPSEEK_DEFAULT_BASE_URL,
        hint: "Override for proxies or compatible gateways. Leave the default for api.deepseek.com.",
      },
      {
        key: "apiKeyEnvVar",
        label: "API key variable",
        type: "text",
        default: DEEPSEEK_API_KEY_ENV,
        hint: "Environment variable (from the agent env or the server) that carries the DeepSeek API key.",
      },
      {
        key: "maxTurns",
        label: "Max model turns per heartbeat",
        type: "number",
        default: DEEPSEEK_CONFIG_DEFAULTS.maxTurns,
        hint: "Each turn is one API call that may include several tool calls.",
      },
      {
        key: "maxTokens",
        label: "Max completion tokens per turn",
        type: "number",
        hint: "Leave empty for the API default. DeepSeek recommends large budgets (256K+) for high/max effort.",
      },
      {
        key: "stream",
        label: "Stream deltas into the run log",
        type: "toggle",
        default: DEEPSEEK_CONFIG_DEFAULTS.stream,
      },
      {
        key: "strictTools",
        label: "Strict function calling (beta endpoint)",
        type: "toggle",
        default: DEEPSEEK_CONFIG_DEFAULTS.strictTools,
        hint: "Sends tools with strict schemas to the DeepSeek beta endpoint so arguments always match the schema.",
      },
      {
        key: "mcpEnabled",
        label: "Expose Paperclip MCP servers as tools",
        type: "toggle",
        default: DEEPSEEK_CONFIG_DEFAULTS.mcpEnabled,
      },
      {
        key: "connectionToolsEnabled",
        label: "Expose connection tools",
        type: "toggle",
        default: DEEPSEEK_CONFIG_DEFAULTS.connectionToolsEnabled,
        hint: "connections_search / connection_request for company connections.",
      },
      {
        key: "shellTimeoutSec",
        label: "Default shell command timeout (s)",
        type: "number",
        default: DEEPSEEK_CONFIG_DEFAULTS.shellTimeoutSec,
      },
      {
        key: "timeoutSec",
        label: "Heartbeat timeout (s)",
        type: "number",
        default: DEEPSEEK_CONFIG_DEFAULTS.timeoutSec,
        hint: "0 disables the timeout.",
      },
      {
        key: "graceSec",
        label: "Grace period before force-kill (s)",
        type: "number",
        default: DEEPSEEK_CONFIG_DEFAULTS.graceSec,
      },
      {
        key: "compactionThresholdTokens",
        label: "Context compaction threshold (tokens)",
        type: "number",
        default: DEEPSEEK_CONFIG_DEFAULTS.compactionThresholdTokens,
        hint: "Older turns are summarized once the prompt exceeds this size. 0 disables compaction.",
      },
      {
        key: "sessionsDir",
        label: "Session transcripts directory",
        type: "text",
        hint: "Defaults to the Paperclip instance directory.",
      },
      {
        key: "sessionMaxAgeDays",
        label: "Delete transcripts older than (days)",
        type: "number",
        default: DEEPSEEK_CONFIG_DEFAULTS.sessionMaxAgeDays,
        hint: "Housekeeping of the sessions directory: transcripts not written for this many days are removed. 0 disables.",
      },
      {
        key: "skillsDir",
        label: "Extra skills directory",
        type: "text",
        hint: "Optional folder of skill directories (each with SKILL.md) loadable via load_skill.",
      },
    ],
  };
}

function skillEntriesFromCatalog(
  catalog: Awaited<ReturnType<typeof buildSkillCatalog>>,
  desired: Set<string>,
): AdapterSkillEntry[] {
  return catalog.map((skill) => {
    const isDesired = desired.has(skill.key) || desired.has(skill.name);
    return {
      key: skill.key,
      runtimeName: skill.name,
      desired: isDesired,
      managed: skill.origin === "paperclip",
      state: isDesired ? "configured" : "available",
      origin: skill.origin === "paperclip" ? "company_managed" : skill.origin === "config" ? "user_installed" : "external_unknown",
      originLabel: skill.origin === "paperclip" ? "Managed by Paperclip" : skill.origin === "config" ? "skillsDir" : "Bundled with adapter",
      locationLabel: skill.sourceDir,
      sourcePath: skill.sourceDir,
      targetPath: null,
      readOnly: skill.origin !== "paperclip",
      detail: SKILL_CONFIGURED_DETAIL,
    };
  });
}

const SKILL_CONFIGURED_DETAIL = "Loaded on demand through the load_skill tool; nothing is written to the workspace.";

/**
 * The Skills panel snapshot: every Paperclip-managed runtime skill (including
 * ones whose materialized source is missing, reported as `missing` with a
 * warning) plus the operator-provided (`skillsDir`) and bundled skills, which
 * are always loadable. At run time only the desired managed skills are exposed
 * (see buildSkillCatalog `desiredOnly`).
 */
async function skillSnapshot(ctx: AdapterSkillContext, desiredOverride?: string[]): Promise<AdapterSkillSnapshot> {
  const config = parseDeepSeekAdapterConfig(ctx.config);
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const runtimeEntries = await readPaperclipRuntimeSkillEntries(ctx.config, moduleDir).catch(() => []);
  const desired = desiredOverride ?? resolvePaperclipDesiredSkillNames(ctx.config, runtimeEntries);
  const managed = buildRuntimeMountedSkillSnapshot({
    adapterType: ctx.adapterType,
    availableEntries: runtimeEntries,
    desiredSkills: desired,
    configuredDetail: SKILL_CONFIGURED_DETAIL,
    missingDetail: "Paperclip could not materialize this skill; its files are unavailable to load_skill.",
    mode: "ephemeral",
  });
  const catalog = await buildSkillCatalog({ config: ctx.config, moduleDir, extraSkillsDir: config.skillsDir || undefined });
  const managedNames = new Set(runtimeEntries.map((entry) => entry.runtimeName.toLowerCase()));
  const extras = catalog.filter((skill) => skill.origin !== "paperclip" && !managedNames.has(skill.name.toLowerCase()));
  return {
    adapterType: ctx.adapterType,
    supported: true,
    mode: "ephemeral",
    desiredSkills: desired,
    entries: [...managed.entries, ...skillEntriesFromCatalog(extras, new Set(desired))],
    warnings: managed.warnings,
  };
}

export async function listSkills(ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot> {
  return skillSnapshot(ctx);
}

export async function syncSkills(ctx: AdapterSkillContext, desiredSkills: string[]): Promise<AdapterSkillSnapshot> {
  return skillSnapshot(ctx, desiredSkills);
}

export async function detectModel(): Promise<{ model: string; provider: string; source: string; candidates?: string[] } | null> {
  const key = resolveDeepSeekApiKey({ env: {}, apiKeyEnvVar: DEEPSEEK_API_KEY_ENV });
  if (!key) return null;
  return {
    model: DEFAULT_DEEPSEEK_MODEL,
    provider: "deepseek",
    source: `${DEEPSEEK_API_KEY_ENV} in server environment`,
    candidates: DEEPSEEK_MODEL_CATALOG.map((model) => model.id),
  };
}

/**
 * Factory used by Paperclip's plugin loader (imported from the package root).
 */
export function createServerAdapter(): ServerAdapterModule {
  return {
    type,
    execute,
    testEnvironment,
    sessionCodec,
    sessionManagement,
    models,
    listModels: () => discoverModels(),
    refreshModels: () => discoverModels({ force: true }),
    detectModel,
    getConfigSchema,
    listSkills,
    syncSkills,
    agentConfigurationDoc,
    supportsLocalAgentJwt: true,
    supportsInstructionsBundle: true,
    instructionsPathKey: "instructionsFilePath",
    requiresMaterializedRuntimeSkills: true,
    // Newer servers read how run-scoped connection tools are delivered; older
    // typings do not know the field, so it is spread in untyped.
    ...({ runtimeToolDelivery: "invocation_context" } as Record<string, unknown>),
  };
}

export { label, models, type };
