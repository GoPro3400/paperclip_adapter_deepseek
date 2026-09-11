#!/usr/bin/env node
/**
 * Manual smoke test: runs one heartbeat of the adapter against the real
 * DeepSeek API without a Paperclip server (the paperclip_api tool is disabled
 * because no run token exists). Useful to verify credentials, model ids and
 * the tool-calling loop before installing the adapter into Paperclip.
 *
 *   DEEPSEEK_API_KEY=sk-... node scripts/smoke-run.mjs --cwd /tmp/demo \
 *     --model deepseek-v4-flash --effort high \
 *     --prompt "List the files in the working directory, then finish."
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
function flag(name, fallback) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
}

const cwd = path.resolve(flag("cwd", await fs.mkdtemp(path.join(os.tmpdir(), "deepseek-smoke-"))));
await fs.mkdir(cwd, { recursive: true });
const model = flag("model", "deepseek-v4-flash");
const effort = flag("effort", "high");
const prompt = flag("prompt", "Introduce yourself in one sentence, list the working directory with list_directory, then call finish_run with disposition no_action.");
const maxTurns = Number(flag("max-turns", "8"));

if (!process.env.DEEPSEEK_API_KEY) {
  console.error("DEEPSEEK_API_KEY is required");
  process.exit(2);
}

const { executeWith } = await import("../dist/server/execute.js");
const { printDeepSeekStreamEvent } = await import("../dist/cli/index.js");

const result = await executeWith(
  {
    runId: `smoke-${Date.now()}`,
    agent: { id: "smoke-agent", companyId: "smoke-company", name: "Smoke Agent", adapterType: "deepseek_api", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: {
      cwd,
      model,
      reasoningEffort: effort,
      maxTurns,
      promptTemplate: prompt,
      sessionsDir: path.join(os.tmpdir(), "deepseek-smoke-sessions"),
      timeoutSec: 600,
    },
    context: { wakeReason: "manual_smoke_test" },
    onLog: async (_stream, chunk) => {
      for (const line of chunk.split("\n")) if (line.trim()) printDeepSeekStreamEvent(line, args.includes("--debug"));
    },
    onMeta: async (meta) => {
      if (args.includes("--debug")) console.log("[meta]", JSON.stringify({ ...meta, prompt: `${meta.prompt?.slice(0, 200)}…` }, null, 2));
    },
  },
  {},
);

console.log("\n=== result ===");
console.log(JSON.stringify({ ...result, resultJson: undefined }, null, 2));
process.exit(result.exitCode === 0 ? 0 : 1);
