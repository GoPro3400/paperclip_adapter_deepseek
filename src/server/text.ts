/** Small text utilities shared by tools and the agent loop. */

export const TRUNCATION_MARKER = "…[truncated]…";

/**
 * Keep the head and tail of an oversized string so both the beginning (usually
 * the important part of a command output) and the end (errors, final status)
 * survive truncation.
 */
export function truncateMiddle(text: string, maxChars: number): { text: string; truncated: boolean; originalChars: number } {
  if (text.length <= maxChars) return { text, truncated: false, originalChars: text.length };
  const budget = Math.max(0, maxChars - TRUNCATION_MARKER.length - 40);
  const headChars = Math.floor(budget * 0.6);
  const tailChars = budget - headChars;
  const head = text.slice(0, headChars);
  const tail = tailChars > 0 ? text.slice(text.length - tailChars) : "";
  const omitted = text.length - head.length - tail.length;
  return {
    text: `${head}\n${TRUNCATION_MARKER} ${omitted} chars omitted ${TRUNCATION_MARKER}\n${tail}`,
    truncated: true,
    originalChars: text.length,
  };
}

/** Rough token estimate used for compaction decisions before real usage arrives. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

const SENSITIVE_ENV_KEY = /(key|token|secret|password|passwd|authorization|cookie|credential)/i;

/**
 * Replaces known secret values in free text so a model that prints its
 * environment or a tool that echoes headers never leaks credentials into the
 * transcript, comments or run logs.
 */
export class SecretRedactor {
  private readonly secrets = new Set<string>();

  add(value: string | null | undefined): void {
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    if (trimmed.length < 8) return;
    this.secrets.add(trimmed);
  }

  addFromEnv(env: Record<string, string>): void {
    for (const [key, value] of Object.entries(env)) {
      if (SENSITIVE_ENV_KEY.test(key)) this.add(value);
    }
  }

  get size(): number {
    return this.secrets.size;
  }

  redact(text: string): string {
    if (!text || this.secrets.size === 0) return text;
    let out = text;
    for (const secret of this.secrets) {
      if (out.includes(secret)) out = out.split(secret).join("***REDACTED***");
    }
    return out;
  }
}

export function safeJsonStringify(value: unknown, space?: number): string {
  try {
    return JSON.stringify(value, null, space) ?? String(value);
  } catch {
    return String(value);
  }
}

export function firstNonEmptyLine(text: string): string {
  return text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  return typeof err === "string" ? err : safeJsonStringify(err);
}
