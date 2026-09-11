/**
 * run_shell: execute a command in the agent's working directory.
 *
 * The command runs through a real shell (bash when available) in its own
 * process group so timeouts can terminate the whole tree. Output is captured
 * with head+tail truncation; the environment is non-interactive.
 */
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { ToolDefinition, ToolResult, ToolRuntime } from "./registry.js";
import { toolErrorResult } from "./registry.js";
import { TRUNCATION_MARKER, safeJsonStringify, truncateMiddle } from "../text.js";

export interface ShellToolOptions {
  env: Record<string, string>;
  defaultTimeoutSec: number;
  maxTimeoutSec: number;
  graceSec: number;
  shell?: string;
  /**
   * Variables of the Paperclip server process that must not reach the shell
   * (the DeepSeek key unless `exposeApiKeyToShell` is set). `env` entries with
   * the same name are still applied, so an operator can expose them explicitly.
   */
  dropKeys?: string[];
}

/** Both ends of a captured stream: the first `head` chars and the last `tail` chars. */
export interface CapturedStream {
  head: string;
  tail: string;
  /** Characters dropped between head and tail while capturing. */
  omittedChars: number;
}

export interface ShellRunResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  /** Captured stdout (head + marker + tail when the capture buffer overflowed). */
  stdout: string;
  stderr: string;
  stdoutCapture: CapturedStream;
  stderrCapture: CapturedStream;
  durationMs: number;
  /** True when the raw capture buffer overflowed (output longer than 4x the tool cap). */
  truncated: boolean;
}

/**
 * How long to wait for the stdout/stderr pipes to close after the shell
 * itself has exited. A detached helper that inherited the pipes (a server
 * started with `&` without redirecting its output) would otherwise hold the
 * call open until the timeout kills the whole process group.
 */
const PIPE_DRAIN_GRACE_MS = 300;

/**
 * Captures the beginning and the end of a stream in bounded memory so the
 * head (banner, first failure) survives even when the tail keeps growing.
 */
export class StreamCapture {
  private head = "";
  private tail = "";
  private omitted = 0;
  private readonly headCap: number;
  private readonly tailCap: number;

  constructor(cap: number) {
    const total = Math.max(200, cap);
    this.headCap = Math.floor(total * 0.6);
    this.tailCap = total - this.headCap;
  }

  get overflowed(): boolean {
    return this.omitted > 0;
  }

  append(chunk: string): void {
    if (!chunk) return;
    let rest = chunk;
    if (this.head.length < this.headCap) {
      const take = Math.min(rest.length, this.headCap - this.head.length);
      this.head += rest.slice(0, take);
      rest = rest.slice(take);
    }
    if (!rest) return;
    const combined = this.tail + rest;
    if (combined.length > this.tailCap) {
      this.omitted += combined.length - this.tailCap;
      this.tail = combined.slice(combined.length - this.tailCap);
    } else {
      this.tail = combined;
    }
  }

  snapshot(): CapturedStream {
    return { head: this.head, tail: this.tail, omittedChars: this.omitted };
  }
}

/**
 * Renders a captured stream within `maxChars`, keeping both ends. Equivalent
 * to `truncateMiddle` on the complete output, but works on a capture whose
 * middle was already dropped so only one marker appears.
 */
export function renderCapturedStream(capture: CapturedStream, maxChars: number): { text: string; truncated: boolean } {
  const full = capture.head + capture.tail;
  if (capture.omittedChars === 0) {
    const capped = truncateMiddle(full, maxChars);
    return { text: capped.text, truncated: capped.truncated };
  }
  const budget = Math.max(0, maxChars - TRUNCATION_MARKER.length - 40);
  const headChars = Math.min(capture.head.length, Math.floor(budget * 0.6));
  const tailChars = Math.min(capture.tail.length, budget - headChars);
  const head = capture.head.slice(0, headChars);
  const tail = tailChars > 0 ? capture.tail.slice(capture.tail.length - tailChars) : "";
  const omitted = capture.omittedChars + (capture.head.length - head.length) + (capture.tail.length - tail.length);
  return {
    text: `${head}\n${TRUNCATION_MARKER} ${omitted} chars omitted ${TRUNCATION_MARKER}\n${tail}`,
    truncated: true,
  };
}

const NON_INTERACTIVE_ENV: Record<string, string> = {
  CI: "1",
  NO_COLOR: "1",
  TERM: "dumb",
  GIT_TERMINAL_PROMPT: "0",
  PAGER: "cat",
  GIT_PAGER: "cat",
  PYTHONUNBUFFERED: "1",
};

export async function resolveShell(preferred?: string): Promise<{ command: string; args: string[] }> {
  if (preferred && preferred.trim()) {
    const value = preferred.trim();
    if (process.platform === "win32" && /cmd(\.exe)?$/i.test(value)) return { command: value, args: ["/d", "/s", "/c"] };
    return { command: value, args: ["-c"] };
  }
  if (process.platform === "win32") {
    return { command: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c"] };
  }
  for (const candidate of ["/bin/bash", "/usr/bin/bash", "/usr/local/bin/bash"]) {
    try {
      await fs.access(candidate);
      return { command: candidate, args: ["-c"] };
    } catch {
      // try next
    }
  }
  return { command: "/bin/sh", args: ["-c"] };
}

function killTree(pid: number | undefined, signal: NodeJS.Signals) {
  if (!pid) return;
  try {
    if (process.platform !== "win32") process.kill(-pid, signal);
    else process.kill(pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // already gone
    }
  }
}

export async function runShellCommand(input: {
  command: string;
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  graceMs: number;
  stdin?: string;
  shell: { command: string; args: string[] };
  signal?: AbortSignal;
  maxCaptureChars: number;
}): Promise<ShellRunResult> {
  const startedAt = Date.now();
  return new Promise<ShellRunResult>((resolve) => {
    let timedOut = false;
    let settled = false;
    const cap = Math.max(4000, input.maxCaptureChars * 4);
    const stdout = new StreamCapture(cap);
    const stderr = new StreamCapture(cap);
    // Decoders keep multibyte UTF-8 sequences intact across chunk boundaries.
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    const child = spawn(input.shell.command, [...input.shell.args, input.command], {
      cwd: input.cwd,
      env: input.env,
      detached: process.platform !== "win32",
      shell: false,
      stdio: [input.stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
    });
    let graceTimer: NodeJS.Timeout | null = null;
    let drainTimer: NodeJS.Timeout | null = null;
    const finish = (result: Pick<ShellRunResult, "exitCode" | "signal" | "timedOut">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      if (drainTimer) clearTimeout(drainTimer);
      input.signal?.removeEventListener("abort", onAbort);
      stdout.append(stdoutDecoder.end());
      stderr.append(stderrDecoder.end());
      const stdoutCapture = stdout.snapshot();
      const stderrCapture = stderr.snapshot();
      resolve({
        ...result,
        stdout: renderCapturedStream(stdoutCapture, cap).text,
        stderr: renderCapturedStream(stderrCapture, cap).text,
        stdoutCapture,
        stderrCapture,
        durationMs: Date.now() - startedAt,
        truncated: stdout.overflowed || stderr.overflowed,
      });
    };
    const terminate = () => {
      killTree(child.pid, "SIGTERM");
      graceTimer = setTimeout(() => killTree(child.pid, "SIGKILL"), input.graceMs);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, input.timeoutMs);
    const onAbort = () => terminate();
    if (input.signal?.aborted) onAbort();
    input.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout.append(stdoutDecoder.write(chunk));
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr.append(stderrDecoder.write(chunk));
    });
    child.on("error", (err) => {
      stderr.append(`\n[spawn error] ${err.message}`);
      finish({ exitCode: null, signal: null, timedOut });
    });
    child.on("exit", (code, signal) => {
      // The shell is gone; give the pipes a moment to deliver what is left,
      // then stop waiting for detached helpers that still hold them open.
      drainTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish({ exitCode: code, signal: signal ?? null, timedOut });
      }, PIPE_DRAIN_GRACE_MS);
    });
    child.on("close", (code, signal) => {
      finish({ exitCode: code, signal: signal ?? null, timedOut });
    });
    if (input.stdin !== undefined && child.stdin) {
      child.stdin.on("error", () => undefined);
      child.stdin.end(input.stdin);
    }
  });
}

/**
 * The shell inherits the Paperclip server process environment (like the other
 * local adapters) minus PAPERCLIP_* (the run sets its own) and `dropKeys`, then
 * the non-interactive defaults, then the run environment on top.
 */
export function buildShellEnv(base: Record<string, string>, dropKeys: readonly string[] = []): Record<string, string> {
  const env: Record<string, string> = {};
  const dropped = new Set(dropKeys.map((key) => key.trim()).filter(Boolean));
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value !== "string") continue;
    if (key.startsWith("PAPERCLIP_")) continue;
    if (dropped.has(key)) continue;
    env[key] = value;
  }
  for (const [key, value] of Object.entries(NON_INTERACTIVE_ENV)) {
    if (!(key in env)) env[key] = value;
  }
  for (const [key, value] of Object.entries(base)) env[key] = value;
  if (!env.PATH && !env.Path) env.PATH = "/usr/local/bin:/usr/bin:/bin";
  return env;
}

export function createShellTool(options: ShellToolOptions): ToolDefinition {
  return {
    name: "run_shell",
    group: "workspace",
    description: [
      "Run a shell command in the working directory and return its exit code, stdout and stderr.",
      "Use it for git, package managers, tests, builds, grep/find, curl and any CLI work.",
      "Commands run non-interactively (no TTY, no prompts). The call returns when the command exits; everything in its process group is terminated when the timeout fires.",
      "Do not start servers here (for preview/dev servers use the Paperclip issue workspace runtime controls, see load_skill paperclip file=references/issue-workspaces.md).",
      "If a helper must keep running after the call, redirect all its output or the call waits for it: `nohup cmd > \"$PAPERCLIP_RUN_SCRATCH_DIR/cmd.log\" 2>&1 < /dev/null &`.",
      "Prefer read_file/edit_file/write_file for file content changes so edits are exact and reviewable.",
      `Default timeout ${options.defaultTimeoutSec}s; request a longer timeout_sec (max ${options.maxTimeoutSec}) for slow builds or test suites.`,
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command line to execute (bash syntax on POSIX hosts)." },
        cwd: {
          type: "string",
          description: "Optional directory to run in. Relative paths resolve against the working directory.",
        },
        timeout_sec: {
          type: "integer",
          minimum: 1,
          maximum: options.maxTimeoutSec,
          description: "Seconds to wait before the command is terminated.",
        },
        stdin: { type: "string", description: "Optional text piped to the command's standard input." },
        description: {
          type: "string",
          description: "Short human-readable purpose of the command (shown in the run log).",
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
    handler: async (args, runtime): Promise<ToolResult> => {
      const command = String(args.command ?? "").trim();
      if (!command) return toolErrorResult("command must not be empty");
      const cwd = typeof args.cwd === "string" && args.cwd.trim() ? path.resolve(runtime.cwd, args.cwd.trim()) : runtime.cwd;
      try {
        const stats = await fs.stat(cwd);
        if (!stats.isDirectory()) return toolErrorResult(`cwd is not a directory: ${cwd}`);
      } catch {
        return toolErrorResult(`cwd does not exist: ${cwd}`);
      }
      const requested = typeof args.timeout_sec === "number" ? Math.floor(args.timeout_sec) : options.defaultTimeoutSec;
      const timeoutSec = Math.min(Math.max(1, requested), options.maxTimeoutSec);
      const shell = await resolveShell(options.shell);
      const result = await runShellCommand({
        command,
        cwd,
        env: buildShellEnv(options.env, options.dropKeys ?? []),
        timeoutMs: timeoutSec * 1000,
        graceMs: Math.max(1000, options.graceSec * 1000),
        stdin: typeof args.stdin === "string" ? args.stdin : undefined,
        shell,
        signal: runtime.signal,
        maxCaptureChars: runtime.maxOutputChars,
      });
      const perStreamCap = Math.max(2000, Math.floor(runtime.maxOutputChars / 2));
      const stdout = renderCapturedStream(result.stdoutCapture, perStreamCap);
      const stderr = renderCapturedStream(result.stderrCapture, perStreamCap);
      const payload: Record<string, unknown> = {
        ok: !result.timedOut && result.exitCode === 0,
        exit_code: result.exitCode,
        signal: result.signal,
        timed_out: result.timedOut,
        duration_ms: result.durationMs,
        cwd,
        stdout: stdout.text,
        stderr: stderr.text,
      };
      if (stdout.truncated || stderr.truncated || result.truncated) {
        payload.truncated = true;
        payload.note = result.truncated
          ? "Output exceeded the capture buffer; only its beginning and end were kept. Re-run with filters (grep, head, tail) or redirect to a file and read ranges."
          : "Output was truncated (beginning and end kept). Re-run with filters (grep, head, tail) to see specific parts.";
      }
      if (result.timedOut) {
        payload.error = `Command timed out after ${timeoutSec}s and was terminated.`;
      }
      return { content: safeJsonStringify(payload), isError: result.timedOut || result.exitCode !== 0 };
    },
  };
}
