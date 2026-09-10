/**
 * DeepSeek model catalog, pricing defaults and API constants.
 *
 * Sources (verified 2026-09-10):
 * - DeepSeek model cards on Hugging Face (deepseek-ai/DeepSeek-V4-Pro-0813,
 *   deepseek-ai/DeepSeek-V4-Flash-0731, deepseek-ai/DeepSeek-V4.1-Flash):
 *   1M-token context, `reasoning_effort` levels `low` | `high` | `max`,
 *   recommended output budget of 256K–384K tokens for high/max effort.
 * - DeepSeek API documentation (https://api-docs.deepseek.com): OpenAI-compatible
 *   `POST /chat/completions`, `thinking: { type: "enabled" | "disabled" }`,
 *   `reasoning_content` on assistant messages, `prompt_cache_hit_tokens` /
 *   `prompt_cache_miss_tokens` usage fields, strict function calling on `/beta`.
 * - models.dev provider registry (mirrors the official pricing page).
 *
 * The legacy aliases `deepseek-chat` / `deepseek-reasoner` were retired by
 * DeepSeek in July 2026 and are intentionally not offered as defaults.
 */

export const DEEPSEEK_DEFAULT_BASE_URL = "https://api.deepseek.com";
export const DEEPSEEK_BETA_PATH = "/beta";
export const DEEPSEEK_API_KEY_ENV = "DEEPSEEK_API_KEY";

export const DEFAULT_DEEPSEEK_MODEL = "deepseek-v4-flash";

export type DeepSeekReasoningEffort = "none" | "low" | "high" | "max";
export const DEEPSEEK_REASONING_EFFORTS: readonly DeepSeekReasoningEffort[] = [
  "none",
  "low",
  "high",
  "max",
];
export const DEFAULT_DEEPSEEK_REASONING_EFFORT: DeepSeekReasoningEffort = "high";

export interface DeepSeekModelInfo {
  id: string;
  label: string;
  contextTokens: number;
  /** Recommended maximum output budget (tokens) for thinking-heavy work. */
  recommendedMaxOutputTokens: number;
  supportsThinking: boolean;
  supportsTools: boolean;
  notes?: string;
}

export const DEEPSEEK_MODEL_CATALOG: readonly DeepSeekModelInfo[] = [
  {
    id: "deepseek-v4-flash",
    label: "DeepSeek V4 Flash (fast, low cost)",
    contextTokens: 1_000_000,
    recommendedMaxOutputTokens: 256_000,
    supportsThinking: true,
    supportsTools: true,
    notes: "Default. Served by the latest Flash-tier weights; billed at the Flash price.",
  },
  {
    id: "deepseek-v4-pro",
    label: "DeepSeek V4 Pro (strongest reasoning & agentic)",
    contextTokens: 1_000_000,
    recommendedMaxOutputTokens: 384_000,
    supportsThinking: true,
    supportsTools: true,
    notes: "DeepSeek-V4-Pro-0813 GA build.",
  },
];

export interface DeepSeekModelPricing {
  /** USD per 1M prompt tokens served from the context cache. */
  cacheHitPerMTok: number;
  /** USD per 1M prompt tokens not served from the cache. */
  cacheMissPerMTok: number;
  /** USD per 1M completion tokens (reasoning tokens are billed as output). */
  outputPerMTok: number;
}

/**
 * Default list prices in USD per 1M tokens. DeepSeek publishes time-of-day
 * discounts and revises prices; treat these as estimates and override them per
 * agent with `adapterConfig.pricing` when exact accounting matters.
 */
export const DEEPSEEK_DEFAULT_PRICING: Record<string, DeepSeekModelPricing> = {
  "deepseek-v4-pro": { cacheHitPerMTok: 0.003625, cacheMissPerMTok: 0.435, outputPerMTok: 0.87 },
  "deepseek-v4-flash": { cacheHitPerMTok: 0.003, cacheMissPerMTok: 0.15, outputPerMTok: 0.6 },
  "deepseek-v4.1-flash": { cacheHitPerMTok: 0.003, cacheMissPerMTok: 0.15, outputPerMTok: 0.6 },
};

export function findDeepSeekModel(id: string): DeepSeekModelInfo | null {
  const normalized = id.trim().toLowerCase();
  return DEEPSEEK_MODEL_CATALOG.find((model) => model.id === normalized) ?? null;
}

export function resolveDeepSeekPricing(
  model: string,
  overrides: Record<string, DeepSeekModelPricing> = {},
): DeepSeekModelPricing | null {
  const normalized = model.trim().toLowerCase();
  const override = overrides[normalized] ?? overrides[model];
  if (override) return override;
  const direct = DEEPSEEK_DEFAULT_PRICING[normalized];
  if (direct) return direct;
  // Dated snapshots (e.g. deepseek-v4-pro-0813) share the family price.
  const family = Object.keys(DEEPSEEK_DEFAULT_PRICING)
    .sort((a, b) => b.length - a.length)
    .find((key) => normalized.startsWith(key));
  return family ? DEEPSEEK_DEFAULT_PRICING[family] ?? null : null;
}
