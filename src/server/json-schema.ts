/**
 * Minimal JSON Schema validator for tool arguments.
 *
 * DeepSeek's function calling is OpenAI-compatible: the model receives JSON
 * Schema parameter definitions and returns a JSON string of arguments. The
 * validator covers the subset used by adapter tools and MCP servers so the loop
 * can reject malformed calls with a precise, model-readable error instead of
 * executing garbage. It is deliberately dependency-free.
 */

export type JsonSchema = Record<string, unknown>;

export interface SchemaValidationError {
  path: string;
  message: string;
}

export interface SchemaValidationResult {
  ok: boolean;
  errors: SchemaValidationError[];
}

function typeOfValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function matchesType(value: unknown, expected: string): boolean {
  const actual = typeOfValue(value);
  if (expected === "number") return actual === "number" || actual === "integer";
  if (expected === "integer") return actual === "integer";
  return actual === expected;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function joinPath(base: string, key: string | number): string {
  if (typeof key === "number") return `${base}[${key}]`;
  return base ? `${base}.${key}` : key;
}

function validateNode(value: unknown, schema: unknown, path: string, errors: SchemaValidationError[]): void {
  if (schema === true || schema === undefined || schema === null) return;
  if (schema === false) {
    errors.push({ path, message: "no value is allowed here" });
    return;
  }
  if (!isRecord(schema)) return;

  if (Array.isArray(schema.anyOf) || Array.isArray(schema.oneOf)) {
    const variants = (schema.anyOf ?? schema.oneOf) as unknown[];
    const matched = variants.some((variant) => {
      const local: SchemaValidationError[] = [];
      validateNode(value, variant, path, local);
      return local.length === 0;
    });
    if (!matched) {
      errors.push({ path, message: `value does not match any of the ${variants.length} allowed variants` });
      return;
    }
  }
  if (Array.isArray(schema.allOf)) {
    for (const variant of schema.allOf) validateNode(value, variant, path, errors);
  }

  if (schema.const !== undefined && JSON.stringify(schema.const) !== JSON.stringify(value)) {
    errors.push({ path, message: `must equal ${JSON.stringify(schema.const)}` });
    return;
  }
  if (Array.isArray(schema.enum)) {
    const allowed = schema.enum as unknown[];
    if (!allowed.some((entry) => JSON.stringify(entry) === JSON.stringify(value))) {
      errors.push({ path, message: `must be one of: ${allowed.map((entry) => JSON.stringify(entry)).join(", ")}` });
      return;
    }
  }

  const typeSpec = schema.type;
  if (typeof typeSpec === "string" || Array.isArray(typeSpec)) {
    const types = (Array.isArray(typeSpec) ? typeSpec : [typeSpec]).filter(
      (entry): entry is string => typeof entry === "string",
    );
    if (schema.nullable === true && !types.includes("null")) types.push("null");
    if (types.length > 0 && !types.some((type) => matchesType(value, type))) {
      errors.push({ path, message: `expected ${types.join(" | ")}, got ${typeOfValue(value)}` });
      return;
    }
  } else if (schema.nullable === true && value === null) {
    return;
  }

  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      errors.push({ path, message: `must be at least ${schema.minLength} characters` });
    }
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
      errors.push({ path, message: `must be at most ${schema.maxLength} characters` });
    }
    if (typeof schema.pattern === "string") {
      try {
        if (!new RegExp(schema.pattern).test(value)) {
          errors.push({ path, message: `must match pattern ${schema.pattern}` });
        }
      } catch {
        // Ignore invalid patterns from third-party schemas.
      }
    }
  }

  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      errors.push({ path, message: `must be >= ${schema.minimum}` });
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      errors.push({ path, message: `must be <= ${schema.maximum}` });
    }
    if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) {
      errors.push({ path, message: `must be > ${schema.exclusiveMinimum}` });
    }
    if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) {
      errors.push({ path, message: `must be < ${schema.exclusiveMaximum}` });
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      errors.push({ path, message: `must contain at least ${schema.minItems} items` });
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      errors.push({ path, message: `must contain at most ${schema.maxItems} items` });
    }
    if (schema.items !== undefined && !Array.isArray(schema.items)) {
      value.forEach((entry, index) => validateNode(entry, schema.items, joinPath(path, index), errors));
    }
  }

  if (isRecord(value)) {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required.filter((k): k is string => typeof k === "string") : [];
    for (const key of required) {
      if (!(key in value) || value[key] === undefined) {
        errors.push({ path: joinPath(path, key), message: "is required" });
      }
    }
    for (const [key, propSchema] of Object.entries(properties)) {
      if (key in value && value[key] !== undefined) {
        validateNode(value[key], propSchema, joinPath(path, key), errors);
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) {
          errors.push({ path: joinPath(path, key), message: "is not a known parameter" });
        }
      }
    } else if (isRecord(schema.additionalProperties)) {
      for (const [key, entry] of Object.entries(value)) {
        if (!(key in properties)) validateNode(entry, schema.additionalProperties, joinPath(path, key), errors);
      }
    }
  }
}

export function validateAgainstSchema(value: unknown, schema: JsonSchema | undefined): SchemaValidationResult {
  const errors: SchemaValidationError[] = [];
  validateNode(value, schema ?? { type: "object" }, "", errors);
  return { ok: errors.length === 0, errors };
}

export function formatSchemaErrors(errors: SchemaValidationError[]): string {
  return errors.map((error) => (error.path ? `${error.path}: ${error.message}` : error.message)).join("; ");
}

/**
 * Convert a tool schema into the shape DeepSeek strict function calling
 * expects (mirrors OpenAI structured outputs): every object lists all
 * properties as required, optional ones accept null, and additional properties
 * are forbidden. Handlers treat null exactly like an omitted argument.
 */
export function toStrictSchema(schema: JsonSchema): JsonSchema {
  const convert = (node: unknown): unknown => {
    if (!isRecord(node)) return node;
    const out: Record<string, unknown> = { ...node };
    const types = typeof out.type === "string" ? [out.type] : Array.isArray(out.type) ? out.type : [];
    if (types.includes("object") || isRecord(out.properties)) {
      const properties = isRecord(out.properties) ? out.properties : {};
      const required = new Set(
        Array.isArray(out.required) ? out.required.filter((k): k is string => typeof k === "string") : [],
      );
      const nextProperties: Record<string, unknown> = {};
      for (const [key, propSchema] of Object.entries(properties)) {
        let converted = convert(propSchema);
        if (!required.has(key) && isRecord(converted)) {
          const propTypes = typeof converted.type === "string"
            ? [converted.type]
            : Array.isArray(converted.type)
              ? converted.type.filter((t): t is string => typeof t === "string")
              : [];
          if (propTypes.length > 0 && !propTypes.includes("null")) {
            converted = { ...converted, type: [...propTypes, "null"] };
          }
        }
        nextProperties[key] = converted;
      }
      out.properties = nextProperties;
      out.required = Object.keys(nextProperties);
      out.additionalProperties = false;
    }
    if (out.items !== undefined && !Array.isArray(out.items)) out.items = convert(out.items);
    for (const key of ["anyOf", "oneOf", "allOf"] as const) {
      if (Array.isArray(out[key])) out[key] = (out[key] as unknown[]).map(convert);
    }
    return out;
  };
  return convert(schema) as JsonSchema;
}

/** Drop null-valued arguments so strict-mode calls look like optional omissions. */
export function stripNullArguments(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === null) continue;
    out[key] = entry;
  }
  return out;
}
