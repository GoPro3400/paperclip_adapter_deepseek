import pc from "picocolors";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function shorten(text: string, max = 400): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > max ? `${single.slice(0, max)}…` : single;
}

/**
 * Pretty-prints one run-log line for `paperclipai run --watch`.
 */
export function printDeepSeekStreamEvent(raw: string, debug: boolean): void {
  const line = raw.trim();
  if (!line) return;
  if (line.startsWith("[paperclip]")) {
    console.log(pc.dim(line));
    return;
  }
  let event: Record<string, unknown> | null = null;
  try {
    event = asRecord(JSON.parse(line));
  } catch {
    console.log(line);
    return;
  }
  if (!event) {
    console.log(line);
    return;
  }
  const type = asString(event.type);
  switch (type) {
    case "deepseek.init":
      console.log(pc.blue(`DeepSeek ${asString(event.model)} (${asString(event.reasoningEffort)}) session ${asString(event.sessionId)}${event.resumed === true ? " resumed" : ""}`));
      return;
    case "deepseek.status":
      console.log(pc.cyan(`status: ${asString(event.message)}`));
      return;
    case "deepseek.warning":
      console.log(pc.yellow(`warning: ${asString(event.message)}`));
      return;
    case "deepseek.error":
      console.log(pc.red(`error: ${asString(event.message)}`));
      return;
    case "deepseek.thinking_delta":
      process.stdout.write(pc.gray(asString(event.text)));
      return;
    case "deepseek.text_delta":
      process.stdout.write(pc.green(asString(event.text)));
      return;
    case "deepseek.thinking":
      console.log(pc.gray(`thinking: ${shorten(asString(event.text), 1000)}`));
      return;
    case "deepseek.assistant":
      console.log(pc.green(`assistant: ${asString(event.text)}`));
      return;
    case "deepseek.user":
      if (debug) console.log(pc.magenta(`prompt: ${shorten(asString(event.text), 600)}`));
      return;
    case "deepseek.tool_call": {
      let input = "";
      try {
        input = JSON.stringify(event.input);
      } catch {
        input = String(event.input);
      }
      console.log(`\n${pc.yellow(`→ ${asString(event.name)}`)} ${pc.dim(shorten(input, debug ? 2000 : 300))}`);
      return;
    }
    case "deepseek.tool_result": {
      const isError = event.isError === true;
      const label = isError ? pc.red(`✗ ${asString(event.name)}`) : pc.green(`✓ ${asString(event.name)}`);
      console.log(`${label} ${pc.dim(`${asNumber(event.durationMs)}ms`)} ${pc.dim(shorten(asString(event.output), debug ? 2000 : 300))}`);
      return;
    }
    case "deepseek.turn": {
      const usage = asRecord(event.usage) ?? {};
      const cost = typeof event.costUsd === "number" ? ` $${event.costUsd.toFixed(4)}` : "";
      console.log(pc.dim(`\n[turn ${asNumber(event.turn)} ${asString(event.finishReason, "?")}: in ${asNumber(usage.cacheMissTokens) + asNumber(usage.cacheHitTokens)} (cached ${asNumber(usage.cacheHitTokens)}), out ${asNumber(usage.completionTokens)}${cost}]`));
      return;
    }
    case "deepseek.result": {
      const status = asString(event.status);
      const color = status === "completed" ? pc.blue : pc.red;
      const usage = asRecord(event.usage) ?? {};
      const cost = typeof event.costUsd === "number" ? ` cost $${event.costUsd.toFixed(4)}` : "";
      console.log(color(`\nDeepSeek run ${status} (${asString(event.stopReason)}${event.disposition ? `, disposition ${asString(event.disposition)}` : ""}) after ${asNumber(event.turns)} turns; tokens in ${asNumber(usage.cacheMissTokens) + asNumber(usage.cacheHitTokens)} out ${asNumber(usage.completionTokens)}${cost}`));
      const summary = asString(event.summary);
      if (summary) console.log(summary);
      const errors = Array.isArray(event.errors) ? event.errors : [];
      for (const error of errors) console.log(pc.red(`  ${String(error)}`));
      return;
    }
    default:
      if (debug) console.log(pc.gray(`event: ${type || "unknown"} ${line}`));
  }
}
