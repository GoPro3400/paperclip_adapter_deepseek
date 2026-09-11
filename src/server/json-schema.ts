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
 * Validation-only keywords that strict (grammar-constrained) decoders may not
 * accept. They are dropped from the copy sent to the API; the local validator
 * still enforces them against the original schema when arguments arrive.
 */
const STRICT_UNSUPPORTED_KEYWORDS = [
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minItems",
  "maxItems",
  "uniqueItems",
] as const;

function schemaTypes(node: Record<string, unknown>): string[] {
  if (typeof node.type === "string") return [node.type];
  if (Array.isArray(node.type)) return node.type.filter((entry): entry is string => typeof entry === "string");
  return [];
}

/** True for a fixed-shape object: a non-empty `properties` map to close over. */
function hasClosedProperties(node: Record<string, unknown>): boolean {
  return isRecord(node.properties) && Object.keys(node.properties).length > 0;
}

/** Make a property schema accept null so a strict decoder can leave it out. */
function nullable(converted: unknown): unknown {
  if (!isRecord(converted)) return converted;
  const types = schemaTypes(converted);
  if (types.length > 0) {
    if (types.includes("null")) return converted;
    const out: Record<string, unknown> = { ...converted, type: [...types, "null"] };
    if (Array.isArray(out.enum) && !out.enum.includes(null)) out.enum = [...out.enum, null];
    return out;
  }
  for (const key of ["anyOf", "oneOf"] as const) {
    const variants = converted[key];
    if (!Array.isArray(variants)) continue;
    const acceptsNull = variants.some((variant) => isRecord(variant) && schemaTypes(variant).includes("null"));
    return acceptsNull ? converted : { ...converted, [key]: [...variants, { type: "null" }] };
  }
  // No type constraint at all (`{}` or description only): null is already allowed.
  return converted;
}

/**
 * Convert a tool schema into the shape DeepSeek strict function calling
 * expects (mirrors OpenAI structured outputs): every fixed-shape object lists
 * all properties as required, optional ones accept null, and additional
 * properties are forbidden. Handlers treat null exactly like an omitted
 * argument.
 *
 * Free-form objects (no `properties`, e.g. `paperclip_api` `query` / `body`
 * and many MCP inputs) are left open: closing them would only admit `{}`.
 * Validation-only keywords are stripped (see STRICT_UNSUPPORTED_KEYWORDS).
 */
export function toStrictSchema(schema: JsonSchema): JsonSchema {
  const convert = (node: unknown): unknown => {
    if (!isRecord(node)) return node;
    const out: Record<string, unknown> = { ...node };
    for (const keyword of STRICT_UNSUPPORTED_KEYWORDS) delete out[keyword];
    if (hasClosedProperties(out)) {
      const properties = out.properties as Record<string, unknown>;
      const required = new Set(
        Array.isArray(out.required) ? out.required.filter((k): k is string => typeof k === "string") : [],
      );
      const nextProperties: Record<string, unknown> = {};
      for (const [key, propSchema] of Object.entries(properties)) {
        const converted = convert(propSchema);
        nextProperties[key] = required.has(key) ? converted : nullable(converted);
      }
      out.properties = nextProperties;
      out.required = Object.keys(nextProperties);
      out.additionalProperties = false;
    } else if (isRecord(out.additionalProperties)) {
      out.additionalProperties = convert(out.additionalProperties);
    }
    if (out.items !== undefined && !Array.isArray(out.items)) out.items = convert(out.items);
    for (const key of ["anyOf", "oneOf", "allOf"] as const) {
      if (Array.isArray(out[key])) out[key] = (out[key] as unknown[]).map(convert);
    }
    return out;
  };
  return convert(schema) as JsonSchema;
}

/**
 * Drop the nulls strict mode makes the model emit for omitted optional
 * arguments. With a schema the walk follows it: only optional properties of
 * fixed-shape objects (the ones `toStrictSchema` made nullable) are stripped,
 * recursively through nested objects, arrays and anyOf/oneOf variants, while
 * free-form objects keep their nulls (a `paperclip_api` body may legitimately
 * clear a field with null). Without a schema only top-level nulls are dropped.
 */
export function stripNullArguments(value: unknown, schema?: JsonSchema): unknown {
  if (schema === undefined) {
    if (!isRecord(value)) return value;
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry === null) continue;
      out[key] = entry;
    }
    return out;
  }
  return stripNullNode(value, schema);
}

function stripNullNode(value: unknown, schema: unknown): unknown {
  if (!isRecord(schema)) return value;
  for (const key of ["anyOf", "oneOf"] as const) {
    const variants = schema[key];
    if (!Array.isArray(variants)) continue;
    const matching = variants.find((variant) => validateAgainstSchema(value, isRecord(variant) ? variant : undefined).ok);
    return matching === undefined ? value : stripNullNode(value, matching);
  }
  if (Array.isArray(value)) {
    return schema.items !== undefined && !Array.isArray(schema.items)
      ? value.map((entry) => stripNullNode(entry, schema.items))
      : value;
  }
  if (!isRecord(value) || !hasClosedProperties(schema)) return value;
  const properties = schema.properties as Record<string, unknown>;
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((k): k is string => typeof k === "string") : []);
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === null && key in properties && !required.has(key)) continue;
    out[key] = key in properties ? stripNullNode(entry, properties[key]) : entry;
  }
  return out;
}
