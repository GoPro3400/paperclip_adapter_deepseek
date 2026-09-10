import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeReasoningEffort, parseDeepSeekAdapterConfig, resolveConfigEnv, resolveDeepSeekApiKey } from "../config.js";
import { resolveDeepSeekPricing } from "../models.js";
import { computeCostUsd } from "../pricing.js";
import { DeepSeekSessionStore, readSessionParams } from "../session-store.js";
import { sessionCodec } from "../index.js";

describe("config", () => {
  it("applies defaults and normalizes values", () => {
    const config = parseDeepSeekAdapterConfig({
      model: " deepseek-v4-pro ",
      reasoningEffort: "medium",
      baseUrl: "https://proxy.example.com/v1/",
      env: { DEEPSEEK_API_KEY: { type: "plain", value: "sk-1" }, OTHER: "x", SECRET: { type: "secret_ref", secretId: "s" } },
      maxTurns: "12",
      timeoutSec: -5,
      pricing: { "deepseek-v4-pro": { cacheHit: 0.01, cacheMiss: 1, output: 2 } },
      disabledTools: ["run_shell", " ", 3],
    });
    expect(config.model).toBe("deepseek-v4-pro");
    expect(config.reasoningEffort).toBe("high");
    expect(config.baseUrl).toBe("https://proxy.example.com/v1");
    expect(config.env).toEqual({ DEEPSEEK_API_KEY: "sk-1", OTHER: "x" });
    expect(config.maxTurns).toBe(12);
    expect(config.timeoutSec).toBe(3600);
    expect(config.pricing["deepseek-v4-pro"]).toEqual({ cacheHitPerMTok: 0.01, cacheMissPerMTok: 1, outputPerMTok: 2 });
    expect(config.disabledTools).toEqual(["run_shell"]);
    expect(normalizeReasoningEffort("off")).toBe("none");
    expect(normalizeReasoningEffort("xhigh")).toBe("max");
    expect(normalizeReasoningEffort(undefined)).toBe("high");
    expect(resolveConfigEnv(null)).toEqual({});
  });

  it("resolves the API key from adapter env or process env", () => {
    expect(resolveDeepSeekApiKey({ env: { DEEPSEEK_API_KEY: "a" }, apiKeyEnvVar: "DEEPSEEK_API_KEY" }, {})).toEqual({ apiKey: "a", source: "adapter_env" });
    expect(resolveDeepSeekApiKey({ env: {}, apiKeyEnvVar: "DEEPSEEK_API_KEY" }, { DEEPSEEK_API_KEY: "b" })).toEqual({ apiKey: "b", source: "process_env" });
    expect(resolveDeepSeekApiKey({ env: {}, apiKeyEnvVar: "CUSTOM" }, { DEEPSEEK_API_KEY: "b" })).toBeNull();
  });
});

describe("pricing", () => {
  it("prices known models, dated snapshots and overrides", () => {
    expect(resolveDeepSeekPricing("deepseek-v4-flash")?.cacheMissPerMTok).toBe(0.15);
    expect(resolveDeepSeekPricing("deepseek-v4-pro-0813")?.outputPerMTok).toBe(0.87);
    expect(resolveDeepSeekPricing("unknown-model")).toBeNull();
    expect(resolveDeepSeekPricing("custom", { custom: { cacheHitPerMTok: 1, cacheMissPerMTok: 2, outputPerMTok: 3 } })?.outputPerMTok).toBe(3);
    const cost = computeCostUsd({ promptTokens: 1_000_000, cacheHitTokens: 500_000, cacheMissTokens: 500_000, completionTokens: 100_000, reasoningTokens: 0 }, resolveDeepSeekPricing("deepseek-v4-flash"));
    expect(cost).toBeCloseTo(0.5 * 0.003 + 0.5 * 0.15 + 0.1 * 0.6, 6);
    expect(computeCostUsd({ promptTokens: 1, cacheHitTokens: 0, cacheMissTokens: 1, completionTokens: 1, reasoningTokens: 0 }, null)).toBeNull();
  });
});

describe("session store", () => {
  it("round-trips transcripts and session params", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "deepseek-sessions-"));
    const store = new DeepSeekSessionStore(dir);
    const session = store.create({ agentId: "a", companyId: "c", cwd: "/work", model: "deepseek-v4-flash", adapterType: "deepseek_api" });
    session.messages.push({ role: "user", content: "hi" }, { role: "assistant", content: "hello", reasoning_content: "r" });
    const saved = await store.save(session);
    expect(saved).toBe(store.transcriptPath(session.sessionId));
    const loaded = await store.load(session.sessionId);
    expect(loaded?.messages).toHaveLength(2);
    expect(loaded?.cwd).toBe("/work");
    const params = store.toSessionParams(session);
    expect(readSessionParams(params)?.sessionId).toBe(session.sessionId);
    expect(sessionCodec.getDisplayId?.(params)).toBe(session.sessionId);
    expect(sessionCodec.deserialize({ session_id: "legacy" })?.sessionId).toBe("legacy");
    expect(sessionCodec.serialize(null)).toBeNull();
    await fs.writeFile(store.transcriptPath("broken"), "{not json");
    expect(await store.load("broken")).toBeNull();
    await fs.rm(dir, { recursive: true, force: true });
  });
});
