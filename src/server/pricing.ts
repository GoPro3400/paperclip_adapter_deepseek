import type { DeepSeekUsageSnapshot } from "./events.js";
import { resolveDeepSeekPricing, type DeepSeekModelPricing } from "./models.js";

export function computeCostUsd(usage: DeepSeekUsageSnapshot, pricing: DeepSeekModelPricing | null): number | null {
  if (!pricing) return null;
  const cost =
    (usage.cacheHitTokens * pricing.cacheHitPerMTok +
      usage.cacheMissTokens * pricing.cacheMissPerMTok +
      usage.completionTokens * pricing.outputPerMTok) /
    1_000_000;
  return Number.isFinite(cost) ? Math.round(cost * 1e10) / 1e10 : null;
}

export function pricingForModel(model: string, overrides: Record<string, DeepSeekModelPricing>): DeepSeekModelPricing | null {
  return resolveDeepSeekPricing(model, overrides);
}
