import { describe, expect, it } from "vitest";
import { chooseCompactionCut, prepareMessagesForRequest, runAgentLoop, thinkingRequestFields } from "../agent-loop.js";
import type { DeepSeekClient, DeepSeekMessage } from "../deepseek-client.js";
import { createFinishRunTool } from "../tools/finish.js";
import { ToolRegistry, toolOkResult, type ToolRuntime } from "../tools/registry.js";
import { FakeClient, chatResult, collectEvents, reasoningShapeError, toolCall, usage } from "./helpers.js";

function registry(strict = false): ToolRegistry {
  const reg = new ToolRegistry({ strict });
  reg.register({
    name: "echo",
    group: "workspace",
    description: "echo",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
    handler: async (args) => toolOkResult({ echoed: args.text }),
  });
  reg.register({
    name: "boom",
    group: "workspace",
    description: "always fails",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => ({ content: '{"ok":false,"error":"boom"}', isError: true }),
  });
  reg.register(createFinishRunTool());
  return reg;
}

const runtime: ToolRuntime = {
  cwd: process.cwd(),
  maxOutputChars: 5000,
  redact: (text) => text,
  log: async () => undefined,
};

function baseInput(client: FakeClient, tools: ToolRegistry, overrides: Partial<Parameters<typeof runAgentLoop>[0]> = {}) {
  const { emit, events } = collectEvents();
  const input: Parameters<typeof runAgentLoop>[0] = {
    client: client as unknown as DeepSeekClient,
    model: "deepseek-v4-flash",
    reasoningEffort: "high",
    maxTokens: null,
    temperature: null,
    topP: null,
    stream: false,
    strictTools: false,
    systemPrompt: "system",
    history: [],
    userPrompt: "Do the task",
    tools,
    toolRuntime: runtime,
    maxTurns: 6,
    emit,
    deadlineAt: null,
    compaction: { thresholdTokens: 0, keepRecentMessages: 4, initialPromptTokens: 0 },
    pricing: { cacheHitPerMTok: 0.003, cacheMissPerMTok: 0.15, outputPerMTok: 0.6 },
    ...overrides,
  };
  return { input, events };
}

describe("thinkingRequestFields / prepareMessagesForRequest", () => {
  it("maps reasoning effort to DeepSeek thinking params", () => {
    expect(thinkingRequestFields("none")).toEqual({ thinking: { type: "disabled" } });
    expect(thinkingRequestFields("max")).toEqual({ thinking: { type: "enabled" }, reasoning_effort: "max" });
  });

  it("applies reasoning policies", () => {
    const messages: DeepSeekMessage[] = [
      { role: "user", content: "a" },
      { role: "assistant", content: "b", reasoning_content: "r1" },
      { role: "user", content: "c" },
      { role: "assistant", content: "", reasoning_content: "", tool_calls: [toolCall("echo", { text: "x" }, "c1")] },
      { role: "tool", tool_call_id: "c1", content: "{}" },
    ];
    const full = prepareMessagesForRequest(messages, "full", true);
    expect((full[1] as { reasoning_content?: string }).reasoning_content).toBe("r1");
    expect((full[3] as { reasoning_content?: string }).reasoning_content).toBe(" ");
    const current = prepareMessagesForRequest(messages, "current_round", true);
    expect("reasoning_content" in current[1]!).toBe(false);
    expect((current[3] as { reasoning_content?: string }).reasoning_content).toBe(" ");
    const none = prepareMessagesForRequest(messages, "full", false);
    expect(none.every((message) => !("reasoning_content" in message))).toBe(true);
  });

  it("chooses a compaction cut on a user boundary", () => {
    const messages: DeepSeekMessage[] = [
      { role: "user", content: "1" },
      { role: "assistant", content: "2" },
      { role: "user", content: "3" },
      { role: "assistant", content: "", tool_calls: [toolCall("echo", {}, "c")] },
      { role: "tool", tool_call_id: "c", content: "x" },
      { role: "assistant", content: "4" },
    ];
    expect(chooseCompactionCut(messages, 2)).toBe(2);
    expect(chooseCompactionCut(messages, 10)).toBe(0);
  });
});

describe("runAgentLoop", () => {
  it("executes tool calls, keeps reasoning_content, and stops on finish_run", async () => {
    const client = new FakeClient([
      chatResult({ reasoningContent: "plan", content: "", toolCalls: [toolCall("echo", { text: "hello" }, "c1")], finishReason: "tool_calls" }),
      chatResult({
        reasoningContent: "done",
        toolCalls: [toolCall("finish_run", { disposition: "done", summary: "Echoed hello and updated the issue." }, "c2")],
        finishReason: "tool_calls",
        usage: usage({ promptTokens: 200, cacheHitTokens: 150, cacheMissTokens: 50, completionTokens: 40 }),
      }),
    ]);
    const { input, events } = baseInput(client, registry());
    const result = await runAgentLoop(input);
    expect(result.stopReason).toBe("finish_run");
    expect(result.finish?.disposition).toBe("done");
    expect(result.finalText).toContain("Echoed hello");
    expect(result.turns).toBe(2);
    expect(result.toolCalls).toBe(2);
    expect(result.usage.cacheHitTokens).toBe(150);
    expect(result.costUsd).toBeCloseTo((150 * 0.003 + 150 * 0.15 + 60 * 0.6) / 1e6, 9);

    const second = client.requests[1]!;
    expect(second.messages[0]).toEqual({ role: "system", content: "system" });
    const assistant = second.messages.find((message) => message.role === "assistant") as { reasoning_content?: string; tool_calls?: unknown[] };
    expect(assistant.reasoning_content).toBe("plan");
    expect(assistant.tool_calls).toHaveLength(1);
    const tool = second.messages.find((message) => message.role === "tool") as { content: string; tool_call_id: string };
    expect(tool.tool_call_id).toBe("c1");
    expect(JSON.parse(tool.content)).toEqual({ ok: true, echoed: "hello" });
    expect(second.thinking).toEqual({ type: "enabled" });
    expect(second.reasoning_effort).toBe("high");
    expect(second.tools?.map((definition) => definition.function.name)).toEqual(["echo", "boom", "finish_run"]);

    expect(events.map((event) => event.type)).toEqual([
      "deepseek.user",
      "deepseek.turn",
      "deepseek.thinking",
      "deepseek.tool_call",
      "deepseek.tool_result",
      "deepseek.turn",
      "deepseek.thinking",
      "deepseek.tool_call",
      "deepseek.tool_result",
    ]);
    expect(result.messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "c2" });
  });

  it("returns invalid tool arguments to the model instead of failing", async () => {
    const client = new FakeClient([
      chatResult({ toolCalls: [toolCall("echo", "{not json", "c1"), toolCall("echo", { wrong: 1 }, "c2"), toolCall("missing", {}, "c3")], finishReason: "tool_calls" }),
      chatResult({ content: "I will finish.", finishReason: "stop" }),
    ]);
    const { input } = baseInput(client, registry());
    const result = await runAgentLoop(input);
    expect(result.stopReason).toBe("final_response");
    expect(result.toolErrors).toBe(3);
    const toolMessages = client.requests[1]!.messages.filter((message) => message.role === "tool") as Array<{ content: string }>;
    expect(toolMessages[0]!.content).toContain("not valid JSON");
    expect(toolMessages[1]!.content).toContain("text: is required");
    expect(toolMessages[1]!.content).toContain("wrong: is not a known parameter");
    expect(JSON.parse(toolMessages[2]!.content).error).toContain('Unknown tool "missing"');
  });

  it("downgrades the reasoning policy when DeepSeek rejects the history shape", async () => {
    const history: DeepSeekMessage[] = [
      { role: "user", content: "earlier" },
      { role: "assistant", content: "ok", reasoning_content: "old reasoning" },
    ];
    const client = new FakeClient([reasoningShapeError(), chatResult({ content: "fine", finishReason: "stop" })]);
    const { input, events } = baseInput(client, registry(), { history });
    const result = await runAgentLoop(input);
    expect(result.stopReason).toBe("final_response");
    expect(result.reasoningPolicy).toBe("current_round");
    const first = client.requests[0]!.messages[2] as { reasoning_content?: string };
    expect(first.reasoning_content).toBe("old reasoning");
    const second = client.requests[1]!.messages[2] as { reasoning_content?: string };
    expect("reasoning_content" in second).toBe(false);
    expect(events.some((event) => event.type === "deepseek.warning" && event.message.includes("policy"))).toBe(true);
  });

  it("asks for a wrap-up without tools when the turn limit is reached", async () => {
    const looping = () => chatResult({ toolCalls: [toolCall("echo", { text: "again" })], finishReason: "tool_calls" });
    const client = new FakeClient([looping(), looping(), chatResult({ content: "Status: partially done." })]);
    const { input } = baseInput(client, registry(), { maxTurns: 2 });
    const result = await runAgentLoop(input);
    expect(result.stopReason).toBe("max_turns");
    expect(result.finalText).toBe("Status: partially done.");
    const wrap = client.requests[2]!;
    expect(wrap.tool_choice).toBe("none");
    expect((wrap.messages.at(-1) as { content: string }).content).toContain("Turn limit");
  });

  it("intervenes after repeated identical failures", async () => {
    const fail = () => chatResult({ toolCalls: [toolCall("boom", {}, "same")], finishReason: "tool_calls" });
    const client = new FakeClient([fail(), fail(), chatResult({ content: "Giving up.", finishReason: "stop" })]);
    const { input, events } = baseInput(client, registry(), { maxRepeatedFailures: 2 });
    const result = await runAgentLoop(input);
    expect(result.stopReason).toBe("final_response");
    const intervention = client.requests[2]!.messages.filter((message) => message.role === "user").at(-1) as { content: string };
    expect(intervention.content).toContain("failed 2 times in a row");
    expect(events.some((event) => event.type === "deepseek.warning" && event.message.includes("Intervened"))).toBe(true);
  });

  it("compacts old context before calling the model", async () => {
    const history: DeepSeekMessage[] = [];
    for (let index = 0; index < 6; index += 1) {
      history.push({ role: "user", content: `question ${index}` });
      history.push({ role: "assistant", content: `answer ${index}`, reasoning_content: "" });
    }
    const client = new FakeClient([
      (request) => {
        expect(request.thinking).toEqual({ type: "disabled" });
        expect(request.tools).toBeUndefined();
        return chatResult({ content: "SUMMARY of earlier work" });
      },
      chatResult({ content: "continuing", finishReason: "stop" }),
    ]);
    const { input, events } = baseInput(client, registry(), {
      history,
      compaction: { thresholdTokens: 1000, keepRecentMessages: 4, initialPromptTokens: 5000 },
    });
    const result = await runAgentLoop(input);
    expect(result.compactions).toBe(1);
    const main = client.requests[1]!;
    expect((main.messages[1] as { content: string }).content).toContain("SUMMARY of earlier work");
    expect(main.messages.length).toBeLessThan(history.length + 2);
    expect(events.some((event) => event.type === "deepseek.status" && event.message.includes("Compacting"))).toBe(true);
    expect(result.messages[0]).toMatchObject({ role: "user" });
  });

  it("reports API failures and cancellation", async () => {
    const failing = new FakeClient([Object.assign(reasoningShapeError(), { message: "DeepSeek API error 402: Insufficient Balance", kind: "insufficient_balance" })]);
    const { input } = baseInput(failing, registry());
    const failed = await runAgentLoop(input);
    expect(failed.stopReason).toBe("error");
    expect(failed.error?.kind).toBe("insufficient_balance");

    const controller = new AbortController();
    controller.abort();
    const cancelled = await runAgentLoop(baseInput(new FakeClient([]), registry(), { signal: controller.signal }).input);
    expect(cancelled.stopReason).toBe("cancelled");
  });

  it("nudges once on an empty response", async () => {
    const client = new FakeClient([chatResult({ content: "   " }), chatResult({ content: "Real answer." })]);
    const { input } = baseInput(client, registry());
    const result = await runAgentLoop(input);
    expect(result.finalText).toBe("Real answer.");
    expect((client.requests[1]!.messages.at(-1) as { content: string }).content).toContain("empty");
  });
});
