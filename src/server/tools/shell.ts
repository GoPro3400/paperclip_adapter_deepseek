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
import type { ToolDefinition, ToolResult, ToolRuntime } from "./registry.js";
import { toolErrorResult } from "./registry.js";
import { safeJsonStringify, truncateMiddle } from "../text.js";

export interface ShellToolOptions {
  env: Record<string, string>;
  defaultTimeoutSec: number;
  maxTimeoutSec: number;
  graceSec: number;
  shell?: string;
}

export interface ShellRunResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
  truncated: boolean;
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
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    let settled = false;
    const cap = Math.max(4000, input.maxCaptureChars * 4);
    const append = (prev: string, chunk: string) => {
      const combined = prev + chunk;
      if (combined.length > cap) {
        truncated = true;
        return combined.slice(combined.length - cap);
      }
      return combined;
    };
    const child = spawn(input.shell.command, [...input.shell.args, input.command], {
      cwd: input.cwd,
      env: input.env,
      detached: process.platform !== "win32",
      shell: false,
      stdio: [input.stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
    });
    const finish = (result: Omit<ShellRunResult, "durationMs" | "truncated" | "stdout" | "stderr">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      input.signal?.removeEventListener("abort", onAbort);
      resolve({ ...result, stdout, stderr, durationMs: Date.now() - startedAt, truncated });
    };
    let graceTimer: NodeJS.Timeout | null = null;
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
      stdout = append(stdout, chunk.toString("utf8"));
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk.toString("utf8"));
    });
    child.on("error", (err) => {
      stderr = append(stderr, `\n[spawn error] ${err.message}`);
      finish({ exitCode: null, signal: null, timedOut });
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

export function buildShellEnv(base: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value !== "string") continue;
    if (key.startsWith("PAPERCLIP_")) continue;
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
      "Commands run non-interactively (no TTY, no prompts); never start long-lived servers without `nohup ... &` and a timeout.",
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
        env: buildShellEnv(options.env),
        timeoutMs: timeoutSec * 1000,
        graceMs: Math.max(1000, options.graceSec * 1000),
        stdin: typeof args.stdin === "string" ? args.stdin : undefined,
        shell,
        signal: runtime.signal,
        maxCaptureChars: runtime.maxOutputChars,
      });
      const perStreamCap = Math.max(2000, Math.floor(runtime.maxOutputChars / 2));
      const stdout = truncateMiddle(result.stdout, perStreamCap);
      const stderr = truncateMiddle(result.stderr, perStreamCap);
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
        payload.note = "Output was truncated. Re-run with filters (grep, head, tail) to see specific parts.";
      }
      if (result.timedOut) {
        payload.error = `Command timed out after ${timeoutSec}s and was terminated.`;
      }
      return { content: safeJsonStringify(payload), isError: result.timedOut || result.exitCode !== 0 };
    },
  };
}
