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

describe("toStrictSchema with free-form and untyped properties (DS-02)", () => {
  const paperclipApi = {
    type: "object",
    properties: {
      method: { type: "string", enum: ["GET", "POST"] },
      path: { type: "string" },
      query: { type: "object", description: "query", additionalProperties: true },
      body: { anyOf: [{ type: "object", additionalProperties: true }, { type: "array" }, { type: "string" }] },
      timeout_sec: { type: "integer", minimum: 1, maximum: 300 },
      mode: { type: "string", enum: ["a", "b"] },
      details: { type: "object" },
      blocker: { type: "object", properties: { owner: { type: "string" }, action: { type: "string" } }, additionalProperties: false },
    },
    required: ["method", "path"],
    additionalProperties: false,
  };

  it("keeps free-form objects open so query/body stay usable", () => {
    const strict = toStrictSchema(paperclipApi) as Record<string, unknown>;
    const props = strict.properties as Record<string, Record<string, unknown>>;
    expect(props.query).toEqual({ type: ["object", "null"], description: "query", additionalProperties: true });
    expect(props.details).toEqual({ type: ["object", "null"] });
    const bodyVariants = props.body!.anyOf as Record<string, unknown>[];
    expect(bodyVariants[0]).toEqual({ type: "object", additionalProperties: true });
    expect(bodyVariants[bodyVariants.length - 1]).toEqual({ type: "null" });
    expect(validateAgainstSchema({ method: "GET", path: "/api/x", query: { z: 1 }, body: { body: "x" }, timeout_sec: 5, mode: "a", details: { any: true }, blocker: { owner: "me", action: "x" } }, strict).ok).toBe(true);
    expect(validateAgainstSchema({ method: "GET", path: "/api/x", query: null, body: null, timeout_sec: null, mode: null, details: null, blocker: null }, strict).ok).toBe(true);
  });

  it("appends null to enums, strips validation keywords and closes fixed-shape objects", () => {
    const strict = toStrictSchema(paperclipApi) as Record<string, unknown>;
    const props = strict.properties as Record<string, Record<string, unknown>>;
    expect(props.mode).toEqual({ type: ["string", "null"], enum: ["a", "b", null] });
    expect(props.method).toEqual({ type: "string", enum: ["GET", "POST"] });
    expect(props.timeout_sec).toEqual({ type: ["integer", "null"] });
    expect(props.blocker).toEqual({
      type: ["object", "null"],
      properties: { owner: { type: ["string", "null"] }, action: { type: ["string", "null"] } },
      required: ["owner", "action"],
      additionalProperties: false,
    });
    expect(strict.required).toEqual(Object.keys(paperclipApi.properties));
  });

  it("stripNullArguments follows the original schema and keeps nulls inside free-form objects", () => {
    const args = { method: "PATCH", path: "/api/issues/1", query: null, body: { assigneeId: null, nested: { x: null } }, blocker: { owner: "me", action: null }, mode: null };
    expect(stripNullArguments(args, paperclipApi)).toEqual({
      method: "PATCH",
      path: "/api/issues/1",
      body: { assigneeId: null, nested: { x: null } },
      blocker: { owner: "me" },
    });
    const list = { type: "object", properties: { items: { type: "array", items: { type: "object", properties: { a: { type: "string" }, b: { type: "string" } }, required: ["a"] } } } };
    expect(stripNullArguments({ items: [{ a: "1", b: null }, { a: null, b: "2" }] }, list)).toEqual({ items: [{ a: "1" }, { a: null, b: "2" }] });
  });
});
