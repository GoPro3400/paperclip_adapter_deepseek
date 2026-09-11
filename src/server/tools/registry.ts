/**
 * Tool registry: declares the functions the model may call, validates the
 * arguments the model produces, and dispatches to handlers.
 */
import type { DeepSeekToolDefinition } from "../deepseek-client.js";
import {
  formatSchemaErrors,
  stripNullArguments,
  toStrictSchema,
  validateAgainstSchema,
  type JsonSchema,
} from "../json-schema.js";
import { safeJsonStringify, truncateMiddle } from "../text.js";

export interface ToolResult {
  /** Text handed back to the model as the tool message content. */
  content: string;
  isError?: boolean;
  /** Set by finish_run to end the loop. */
  finishRun?: {
    disposition: string;
    summary: string;
    details: Record<string, unknown>;
  };
}

export interface ToolRuntime {
  cwd: string;
  signal?: AbortSignal;
  maxOutputChars: number;
  redact: (text: string) => string;
  log: (message: string) => Promise<void>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchema;
  /** Free-form group label used in the system prompt. */
  group: "paperclip" | "workspace" | "control" | "skills" | "connections" | "mcp";
  handler: (args: Record<string, unknown>, runtime: ToolRuntime) => Promise<ToolResult>;
}

export interface ToolInvocationOutcome {
  result: ToolResult;
  validationFailed: boolean;
  unknownTool: boolean;
}

export const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

export function sanitizeToolName(raw: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  return cleaned || "tool";
}

export function toolErrorResult(message: string, extra: Record<string, unknown> = {}): ToolResult {
  return { content: safeJsonStringify({ ok: false, error: message, ...extra }), isError: true };
}

export function toolOkResult(payload: Record<string, unknown>): ToolResult {
  return { content: safeJsonStringify({ ok: true, ...payload }) };
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  constructor(private readonly options: { strict: boolean }) {}

  register(tool: ToolDefinition): void {
    if (!TOOL_NAME_PATTERN.test(tool.name)) {
      throw new Error(`Invalid tool name "${tool.name}": must match ${TOOL_NAME_PATTERN}`);
    }
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered`);
    }
    this.tools.set(tool.name, tool);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  get size(): number {
    return this.tools.size;
  }

  /** OpenAI/DeepSeek function definitions for the request `tools` field. */
  definitions(): DeepSeekToolDefinition[] {
    return this.list().map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: this.options.strict ? toStrictSchema(tool.parameters) : tool.parameters,
        ...(this.options.strict ? { strict: true } : {}),
      },
    }));
  }

  /**
   * Parse the model's argument string. In strict mode the nulls the strict
   * schema forces for omitted optional properties are dropped, guided by the
   * tool's original schema when given so free-form objects keep their values.
   */
  parseArguments(raw: string, schema?: JsonSchema): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
    const text = raw.trim();
    if (!text) return { ok: true, value: {} };
    try {
      const parsed = JSON.parse(text) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return { ok: false, error: "arguments must be a JSON object" };
      }
      return { ok: true, value: (this.options.strict ? stripNullArguments(parsed, schema) : parsed) as Record<string, unknown> };
    } catch (err) {
      return { ok: false, error: `arguments are not valid JSON (${err instanceof Error ? err.message : String(err)})` };
    }
  }

  async invoke(name: string, rawArguments: string, runtime: ToolRuntime): Promise<ToolInvocationOutcome> {
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        result: toolErrorResult(`Unknown tool "${name}". Available tools: ${this.names().join(", ")}`),
        validationFailed: false,
        unknownTool: true,
      };
    }
    const parsed = this.parseArguments(rawArguments, tool.parameters);
    if (!parsed.ok) {
      return {
        result: toolErrorResult(`Invalid arguments for ${name}: ${parsed.error}. Send a JSON object matching the tool schema.`, {
          expectedParameters: tool.parameters,
        }),
        validationFailed: true,
        unknownTool: false,
      };
    }
    const validation = validateAgainstSchema(parsed.value, tool.parameters);
    if (!validation.ok) {
      return {
        result: toolErrorResult(`Invalid arguments for ${name}: ${formatSchemaErrors(validation.errors)}`, {
          expectedParameters: tool.parameters,
          received: parsed.value,
        }),
        validationFailed: true,
        unknownTool: false,
      };
    }
    let result: ToolResult;
    try {
      result = await tool.handler(parsed.value, runtime);
    } catch (err) {
      result = toolErrorResult(`${name} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const redacted = runtime.redact(result.content);
    const truncated = truncateMiddle(redacted, runtime.maxOutputChars);
    return {
      result: { ...result, content: truncated.text },
      validationFailed: false,
      unknownTool: false,
    };
  }
}
