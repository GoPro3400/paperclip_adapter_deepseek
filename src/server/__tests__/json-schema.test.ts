import { describe, expect, it } from "vitest";
import { formatSchemaErrors, stripNullArguments, toStrictSchema, validateAgainstSchema } from "../json-schema.js";

const schema = {
  type: "object",
  properties: {
    command: { type: "string", minLength: 1 },
    timeout_sec: { type: "integer", minimum: 1, maximum: 60 },
    mode: { type: "string", enum: ["fast", "slow"] },
    tags: { type: "array", items: { type: "string" }, maxItems: 2 },
  },
  required: ["command"],
  additionalProperties: false,
};

describe("validateAgainstSchema", () => {
  it("accepts valid arguments", () => {
    expect(validateAgainstSchema({ command: "ls", timeout_sec: 5, mode: "fast", tags: ["a"] }, schema).ok).toBe(true);
  });

  it("reports missing required, wrong types, enum, bounds and unknown keys", () => {
    const result = validateAgainstSchema({ timeout_sec: 0.5, mode: "medium", tags: ["a", "b", "c"], extra: 1 }, schema);
    expect(result.ok).toBe(false);
    const text = formatSchemaErrors(result.errors);
    expect(text).toContain("command: is required");
    expect(text).toContain("timeout_sec: expected integer");
    expect(text).toContain("mode: must be one of");
    expect(text).toContain("tags: must contain at most 2");
    expect(text).toContain("extra: is not a known parameter");
  });

  it("handles anyOf and nullable types", () => {
    const body = { anyOf: [{ type: "object" }, { type: "array" }, { type: "string" }] };
    expect(validateAgainstSchema({ a: 1 }, body).ok).toBe(true);
    expect(validateAgainstSchema(42, body).ok).toBe(false);
    expect(validateAgainstSchema(null, { type: ["string", "null"] }).ok).toBe(true);
    expect(validateAgainstSchema(null, { type: "string" }).ok).toBe(false);
  });

  it("treats a missing schema as an object requirement", () => {
    expect(validateAgainstSchema({}, undefined).ok).toBe(true);
    expect(validateAgainstSchema("x", undefined).ok).toBe(false);
  });
});

describe("toStrictSchema", () => {
  it("marks every property required, optional ones nullable, and forbids extras", () => {
    const strict = toStrictSchema(schema) as Record<string, unknown>;
    expect(strict.required).toEqual(["command", "timeout_sec", "mode", "tags"]);
    expect(strict.additionalProperties).toBe(false);
    const props = strict.properties as Record<string, Record<string, unknown>>;
    expect(props.command!.type).toBe("string");
    expect(props.timeout_sec!.type).toEqual(["integer", "null"]);
    expect(props.mode!.type).toEqual(["string", "null"]);
  });

  it("stripNullArguments drops null values", () => {
    expect(stripNullArguments({ a: 1, b: null, c: "x" })).toEqual({ a: 1, c: "x" });
  });
});
