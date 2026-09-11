import { describe, expect, it, vi } from "vitest";
import { printDeepSeekStreamEvent } from "../../cli/format-event.js";
import { buildDeepSeekConfig } from "../../ui/build-config.js";
import { createStdoutParser, parseStdoutLine } from "../../ui-parser.js";
import { eventLine } from "../events.js";

const ts = "2026-09-10T12:00:00.000Z";

describe("ui parser", () => {
  it("maps run-log events to transcript entries", () => {
    const init = parseStdoutLine(
      eventLine({ type: "deepseek.init", sessionId: "s1", model: "deepseek-v4-pro", resumed: true, reasoningEffort: "high", baseUrl: "u", toolNames: ["a"], historyMessages: 4 }),
      ts,
    );
    expect(init[0]).toMatchObject({ kind: "init", model: "deepseek-v4-pro (effort: high)", sessionId: "s1" });
    expect(init[1]).toMatchObject({ kind: "system" });
    expect(parseStdoutLine(eventLine({ type: "deepseek.thinking_delta", text: "hm" }), ts)).toEqual([{ kind: "thinking", ts, text: "hm", delta: true }]);
    expect(parseStdoutLine(eventLine({ type: "deepseek.text_delta", text: "hi" }), ts)).toEqual([{ kind: "assistant", ts, text: "hi", delta: true }]);
    expect(parseStdoutLine(eventLine({ type: "deepseek.tool_call", toolCallId: "c1", name: "run_shell", input: { command: "ls" } }), ts)).toEqual([
      { kind: "tool_call", ts, name: "run_shell", toolUseId: "c1", input: { command: "ls" } },
    ]);
    expect(parseStdoutLine(eventLine({ type: "deepseek.tool_result", toolCallId: "c1", name: "run_shell", output: "x", isError: true, durationMs: 5 }), ts)).toEqual([
      { kind: "tool_result", ts, toolUseId: "c1", toolName: "run_shell", content: "x", isError: true },
    ]);
    const result = parseStdoutLine(
      eventLine({
        type: "deepseek.result",
        status: "completed",
        stopReason: "finish_run",
        summary: "done",
        disposition: "done",
        turns: 3,
        usage: { promptTokens: 10, cacheHitTokens: 4, cacheMissTokens: 6, completionTokens: 2, reasoningTokens: 1 },
        costUsd: 0.01,
        sessionId: "s1",
        errors: [],
      }),
      ts,
    );
    expect(result[0]).toMatchObject({ kind: "result", text: "done", inputTokens: 6, cachedTokens: 4, outputTokens: 2, costUsd: 0.01, isError: false, subtype: "completed:done:finish_run" });
    expect(parseStdoutLine("[paperclip] note", ts)).toEqual([{ kind: "system", ts, text: "note" }]);
    expect(parseStdoutLine("plain text", ts)).toEqual([{ kind: "stdout", ts, text: "plain text" }]);
    expect(parseStdoutLine("", ts)).toEqual([]);
    const parser = createStdoutParser();
    expect(parser.parseLine(eventLine({ type: "deepseek.error", message: "bad" }), ts)).toEqual([{ kind: "stderr", ts, text: "bad" }]);
    parser.reset();
  });
});

describe("cli formatter", () => {
  it("prints events without throwing", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    printDeepSeekStreamEvent(eventLine({ type: "deepseek.init", sessionId: "s", model: "m", resumed: false, reasoningEffort: "high", baseUrl: "u", toolNames: [], historyMessages: 0 }), false);
    printDeepSeekStreamEvent(eventLine({ type: "deepseek.text_delta", text: "x" }), false);
    printDeepSeekStreamEvent(eventLine({ type: "deepseek.tool_call", toolCallId: "c", name: "read_file", input: { path: "a" } }), true);
    printDeepSeekStreamEvent(eventLine({ type: "deepseek.tool_result", toolCallId: "c", name: "read_file", output: "ok", isError: false, durationMs: 1 }), false);
    printDeepSeekStreamEvent("not json", false);
    printDeepSeekStreamEvent("[paperclip] hi", false);
    expect(log).toHaveBeenCalled();
    expect(write).toHaveBeenCalled();
    log.mockRestore();
    write.mockRestore();
  });
});

describe("build config", () => {
  it("maps form values to adapterConfig", () => {
    const config = buildDeepSeekConfig({
      adapterType: "deepseek_api",
      cwd: "/work",
      instructionsFilePath: "/work/AGENTS.md",
      promptTemplate: "",
      model: "",
      thinkingEffort: "max",
      chrome: false,
      dangerouslySkipPermissions: false,
      search: false,
      fastMode: false,
      dangerouslyBypassSandbox: false,
      command: "",
      args: "",
      extraArgs: "",
      envVars: "DEEPSEEK_API_KEY=sk",
      envBindings: {},
      url: "",
      bootstrapPrompt: "",
      maxTurnsPerRun: 0,
      heartbeatEnabled: true,
      intervalSec: 0,
      adapterSchemaValues: { maxTurns: 20, sessionsDir: "" },
    });
    expect(config).toMatchObject({ cwd: "/work", model: "deepseek-flash", reasoningEffort: "max", maxTurns: 20, graceSec: 15 });
    expect((config.env as Record<string, unknown>).DEEPSEEK_API_KEY).toEqual({ type: "plain", value: "sk" });
    expect("sessionsDir" in config).toBe(false);
  });
});
