/**
 * DeepSeek model catalog, pricing and API constants.
 *
 * Verified against the official documentation at https://api-docs.deepseek.com
 * on 2026-09-11 (Models & Pricing, Thinking Mode, Tool Calls, Create Chat
 * Completion). See docs/deepseek-api-notes.md for the quoted source text.
 *
 * Key facts encoded here:
 * - OpenAI-compatible base URL https://api.deepseek.com; strict function
 *   calling requires the /beta base URL.
 * - `deepseek-flash` is the current model name and maps to DeepSeek-V4.1-Flash.
 *   `deepseek-v4-flash` and `deepseek-v4-flash-vision-exp` are legacy names:
 *   still accepted, served by the same V4.1-Flash weights, billed at the Flash
 *   price. `deepseek-chat` / `deepseek-reasoner` were retired in July 2026.
 * - Both models: 1M context, max output 384K (393216) tokens.
 * - `reasoning_effort` accepts none | low | high | max; the default is high and
 *   `none` disables thinking mode.
 * - Prices are per 1M tokens and double during peak hours.
 */

export const DEEPSEEK_DEFAULT_BASE_URL = "https://api.deepseek.com";
export const DEEPSEEK_BETA_PATH = "/beta";
export const DEEPSEEK_API_KEY_ENV = "DEEPSEEK_API_KEY";

export const DEFAULT_DEEPSEEK_MODEL = "deepseek-flash";

/** Hard API limit for `max_tokens` (1 .. 384K). */
export const DEEPSEEK_MAX_OUTPUT_TOKENS = 393_216;

/**
 * API defaults for `max_tokens` when the request omits it, by thinking mode.
 * Documented on the Create Chat Completion page; the adapter does not send
 * `max_tokens` unless configured, so these are what actually apply.
 */
export const DEEPSEEK_DEFAULT_MAX_TOKENS = {
  nonThinking: 8_192,
  thinking: 65_536,
  thinkingMaxEffort: 131_072,
} as const;

export type DeepSeekReasoningEffort = "none" | "low" | "high" | "max";
export const DEEPSEEK_REASONING_EFFORTS: readonly DeepSeekReasoningEffort[] = [
  "none",
  "low",
  "high",
  "max",
];
export const DEFAULT_DEEPSEEK_REASONING_EFFORT: DeepSeekReasoningEffort = "high";

/**
 * How DeepSeek maps requested effort levels onto its own, per the Thinking Mode
 * page. Only none/low/high/max are valid values of `reasoning_effort`, so the
 * adapter folds the other spellings before sending the request.
 */
export const DEEPSEEK_EFFORT_ALIASES: Record<string, DeepSeekReasoningEffort> = {
  minimal: "low",
  medium: "high",
  xhigh: "high",
  ultra: "max",
};

export interface DeepSeekModelInfo {
  id: string;
  label: string;
  /** Underlying weights the API id currently serves. */
  modelVersion: string;
  contextTokens: number;
  maxOutputTokens: number;
  supportsThinking: boolean;
  supportsTools: boolean;
  supportsVision: boolean;
  /** True when the id is kept only for backwards compatibility. */
  legacy?: boolean;
  notes?: string;
}

export const DEEPSEEK_MODEL_CATALOG: readonly DeepSeekModelInfo[] = [
  {
    id: "deepseek-flash",
    label: "DeepSeek Flash (V4.1, recommended)",
    modelVersion: "DeepSeek-V4.1-Flash",
    contextTokens: 1_000_000,
    maxOutputTokens: DEEPSEEK_MAX_OUTPUT_TOKENS,
    supportsThinking: true,
    supportsTools: true,
    supportsVision: true,
    notes: "Current model name. Fast, cheapest tier, strongest agentic scores of the two.",
  },
  {
    id: "deepseek-v4-pro",
    label: "DeepSeek V4 Pro (being retired)",
    modelVersion: "DeepSeek-V4-Pro-0813",
    contextTokens: 1_000_000,
    maxOutputTokens: DEEPSEEK_MAX_OUTPUT_TOKENS,
    supportsThinking: true,
    supportsTools: true,
    supportsVision: false,
    notes:
      "From 2026-09-14 04:00 UTC DeepSeek routes this id to V4.1 Flash and bills it at the Flash price. Prefer deepseek-flash.",
  },
  {
    id: "deepseek-v4-flash",
    label: "DeepSeek V4 Flash (legacy name)",
    modelVersion: "DeepSeek-V4.1-Flash",
    contextTokens: 1_000_000,
    maxOutputTokens: DEEPSEEK_MAX_OUTPUT_TOKENS,
    supportsThinking: true,
    supportsTools: true,
    supportsVision: true,
    legacy: true,
    notes: "Accepted for compatibility; served by V4.1 Flash at the Flash price. Use deepseek-flash.",
  },
];

export interface DeepSeekModelPricing {
  /** USD per 1M prompt tokens served from the context cache. */
  cacheHitPerMTok: number;
  /** USD per 1M prompt tokens not served from the cache. */
  cacheMissPerMTok: number;
  /** USD per 1M completion tokens (reasoning tokens bill as output). */
  outputPerMTok: number;
}

export interface DeepSeekTieredPricing {
  offPeak: DeepSeekModelPricing;
  peak: DeepSeekModelPricing;
}

const FLASH_PRICING: DeepSeekTieredPricing = {
  offPeak: { cacheHitPerMTok: 0.003, cacheMissPerMTok: 0.15, outputPerMTok: 0.6 },
  peak: { cacheHitPerMTok: 0.006, cacheMissPerMTok: 0.3, outputPerMTok: 1.2 },
};

const PRO_PRICING: DeepSeekTieredPricing = {
  offPeak: { cacheHitPerMTok: 0.022, cacheMissPerMTok: 0.66, outputPerMTok: 1.98 },
  peak: { cacheHitPerMTok: 0.044, cacheMissPerMTok: 1.32, outputPerMTok: 3.96 },
};

/** Official list prices, USD per 1M tokens (Models & Pricing, 2026-09-11). */
export const DEEPSEEK_DEFAULT_PRICING: Record<string, DeepSeekTieredPricing> = {
  "deepseek-flash": FLASH_PRICING,
  "deepseek-v4-flash": FLASH_PRICING,
  "deepseek-v4-flash-vision-exp": FLASH_PRICING,
  "deepseek-v4.1-flash": FLASH_PRICING,
  "deepseek-v4-pro": PRO_PRICING,
};

/**
 * From this moment DeepSeek routes `deepseek-v4-pro` to V4.1 Flash and bills it
 * at the Flash price ("From 12:00 Beijing Time on September 14, 2026" = 04:00
 * UTC). After it, pricing `deepseek-v4-pro` at the Pro rate would overstate
 * cost roughly threefold.
 */
export const DEEPSEEK_V4_PRO_FLASH_BILLING_FROM = Date.UTC(2026, 8, 14, 4, 0, 0);

/**
 * Peak pricing windows in UTC: 01:00-04:00 and 06:00-10:00, Monday to Friday.
 * Off-peak rates are half the peak rates.
 */
export function isDeepSeekPeakWindow(at: Date = new Date()): boolean {
  const day = at.getUTCDay();
  if (day === 0 || day === 6) return false;
  const hour = at.getUTCHours();
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10);
}

export function findDeepSeekModel(id: string): DeepSeekModelInfo | null {
  const normalized = id.trim().toLowerCase();
  return DEEPSEEK_MODEL_CATALOG.find((model) => model.id === normalized) ?? null;
}

function tieredPricingFor(model: string, at: Date): DeepSeekTieredPricing | null {
  const normalized = model.trim().toLowerCase();
  if (normalized === "deepseek-v4-pro" && at.getTime() >= DEEPSEEK_V4_PRO_FLASH_BILLING_FROM) {
    return FLASH_PRICING;
  }
  const direct = DEEPSEEK_DEFAULT_PRICING[normalized];
  if (direct) return direct;
  // Dated snapshots (e.g. deepseek-v4-pro-0813) share the family price.
  const family = Object.keys(DEEPSEEK_DEFAULT_PRICING)
    .sort((a, b) => b.length - a.length)
    .find((key) => normalized.startsWith(key));
  return family ? (DEEPSEEK_DEFAULT_PRICING[family] ?? null) : null;
}

/**
 * Resolve the price list for a model at a point in time. An operator override
 * (`adapterConfig.pricing`) is a flat rate and wins for both tiers; otherwise
 * the official tier for the current peak/off-peak window applies.
 */
export function resolveDeepSeekPricing(
  model: string,
  overrides: Record<string, DeepSeekModelPricing> = {},
  at: Date = new Date(),
): DeepSeekModelPricing | null {
  const normalized = model.trim().toLowerCase();
  const override = overrides[normalized] ?? overrides[model];
  if (override) return override;
  const tiered = tieredPricingFor(normalized, at);
  if (!tiered) return null;
  return isDeepSeekPeakWindow(at) ? tiered.peak : tiered.offPeak;
}
