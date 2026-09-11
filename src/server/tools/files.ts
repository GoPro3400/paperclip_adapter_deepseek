/**
 * Workspace file tools: read_file, write_file, edit_file, list_directory,
 * search_files. Paths resolve against the run's working directory; absolute
 * paths are allowed so agents can read instructions bundles and skills.
 */
import { promises as fs, type Dirent } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ToolDefinition, ToolResult } from "./registry.js";
import { toolErrorResult, toolOkResult } from "./registry.js";
import { safeJsonStringify, truncateMiddle } from "../text.js";

export interface FileToolOptions {
  maxFileReadChars: number;
  /**
   * Run environment used to expand `$PAPERCLIP_*` references in paths (for
   * example `$PAPERCLIP_RUN_SCRATCH_DIR/notes.md`). Only PAPERCLIP_* variables
   * of this environment and HOME are expanded, never the server process env.
   */
  env?: Record<string, string>;
}

const DEFAULT_IGNORED_DIRS = new Set([".git", "node_modules", ".pnpm-store", ".venv", "venv", "__pycache__", ".cache", "dist", "build", ".next", ".turbo"]);
const MAX_SEARCH_FILE_BYTES = 2 * 1024 * 1024;
/** read_file loads the whole file; larger files must be paged with run_shell (sed/grep). */
export const MAX_READ_FILE_BYTES = 32 * 1024 * 1024;
/** Files scanned between event-loop yields during a search or listing walk. */
const WALK_YIELD_EVERY = 25;
/** A quantified group that itself contains a quantifier: `(a+)+`, `(\d*)*`, `(x|y+){2,}`. */
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)[+*{]/;

/**
 * Expands `~`, `$HOME` and `$PAPERCLIP_*` / `${PAPERCLIP_*}` references (from
 * the run environment only) and resolves the path against the working directory.
 */
export function resolveWorkspacePath(cwd: string, raw: unknown, env: Record<string, string> = {}): string {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) return cwd;
  const substituted = value.replace(/\$\{?(PAPERCLIP_[A-Z0-9_]+|HOME)\}?/g, (match, name: string) => {
    if (name === "HOME") return env.HOME ?? os.homedir();
    const resolved = env[name];
    return typeof resolved === "string" && resolved.length > 0 ? resolved : match;
  });
  const expanded = substituted === "~" ? os.homedir() : substituted.startsWith("~/") ? path.join(os.homedir(), substituted.slice(2)) : substituted;
  return path.resolve(cwd, expanded);
}

/** True when the regular expression is likely to backtrack catastrophically on a long line. */
export function hasNestedQuantifier(pattern: string): boolean {
  return NESTED_QUANTIFIER.test(pattern);
}

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

function isBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8000));
  for (const byte of sample) {
    if (byte === 0) return true;
  }
  return false;
}

/** Converts a glob (`*`, `**`, `?`, `{a,b}` groups) into an anchored regular expression. */
export function globToRegExp(glob: string): RegExp {
  let out = "^";
  let braceDepth = 0;
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index]!;
    if (char === "*") {
      if (glob[index + 1] === "*") {
        out += ".*";
        index += 1;
        if (glob[index + 1] === "/") index += 1;
      } else {
        out += "[^/]*";
      }
    } else if (char === "?") {
      out += "[^/]";
    } else if (char === "{") {
      braceDepth += 1;
      out += "(?:";
    } else if (char === "}" && braceDepth > 0) {
      braceDepth -= 1;
      out += ")";
    } else if (char === "," && braceDepth > 0) {
      out += "|";
    } else if (".+^${}()|[]\\".includes(char)) {
      out += `\\${char}`;
    } else {
      out += char;
    }
  }
  while (braceDepth > 0) {
    out += ")";
    braceDepth -= 1;
  }
  return new RegExp(`${out}$`);
}

async function walk(
  root: string,
  options: { maxDepth: number; includeHidden: boolean; ignoreDirs: Set<string>; limit: number; signal?: AbortSignal },
  visit: (entry: { path: string; relative: string; dirent: Dirent; depth: number }) => Promise<boolean | void>,
): Promise<{ count: number; limited: boolean; aborted: boolean }> {
  let count = 0;
  let limited = false;
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (queue.length > 0) {
    if (options.signal?.aborted) return { count, limited, aborted: true };
    const current = queue.shift()!;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const dirent of entries) {
      if (!options.includeHidden && dirent.name.startsWith(".") && dirent.name !== ".") continue;
      const fullPath = path.join(current.dir, dirent.name);
      const relative = path.relative(root, fullPath) || dirent.name;
      if (count >= options.limit) {
        limited = true;
        return { count, limited, aborted: false };
      }
      if (options.signal?.aborted) return { count, limited, aborted: true };
      const stop = await visit({ path: fullPath, relative, dirent, depth: current.depth + 1 });
      count += 1;
      if (count % WALK_YIELD_EVERY === 0) await yieldToEventLoop();
      if (stop === true) return { count, limited, aborted: false };
      if (dirent.isDirectory() && current.depth + 1 < options.maxDepth && !options.ignoreDirs.has(dirent.name)) {
        queue.push({ dir: fullPath, depth: current.depth + 1 });
      }
    }
  }
  return { count, limited, aborted: false };
}

export function createFileTools(options: FileToolOptions): ToolDefinition[] {
  const readFile: ToolDefinition = {
    name: "read_file",
    group: "workspace",
    description: [
      "Read a UTF-8 text file. Returns the content (optionally a line range) plus total line count.",
      "Use offset/limit to page through large files. Binary files are rejected.",
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path, relative to the working directory or absolute." },
        offset: { type: "integer", minimum: 1, description: "1-based line number to start from (default 1)." },
        limit: { type: "integer", minimum: 1, description: "Maximum number of lines to return." },
      },
      required: ["path"],
      additionalProperties: false,
    },
    handler: async (args, runtime): Promise<ToolResult> => {
      const target = resolveWorkspacePath(runtime.cwd, args.path, options.env);
      let buffer: Buffer;
      try {
        const stats = await fs.stat(target);
        if (stats.isDirectory()) return toolErrorResult(`${target} is a directory; use list_directory`);
        if (stats.size > MAX_READ_FILE_BYTES) {
          return toolErrorResult(
            `${target} is too large to read at once (${stats.size} bytes, limit ${MAX_READ_FILE_BYTES}). Use run_shell with sed -n 'START,ENDp', grep or tail to read the part you need.`,
          );
        }
        buffer = await fs.readFile(target);
      } catch (err) {
        return toolErrorResult(`Cannot read ${target}: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (isBinary(buffer)) return toolErrorResult(`${target} looks like a binary file (${buffer.length} bytes)`);
      const text = buffer.toString("utf8");
      const lines = text.split(/\r?\n/);
      // A trailing newline terminates the last line; it does not start an empty
      // one (the segment stays in `lines` so the returned content is verbatim).
      const totalLines = lines.length > 1 && lines[lines.length - 1] === "" ? lines.length - 1 : text.length === 0 ? 0 : lines.length;
      const offset = typeof args.offset === "number" ? Math.max(1, Math.floor(args.offset)) : 1;
      const limit = typeof args.limit === "number" ? Math.max(1, Math.floor(args.limit)) : null;
      const selected = lines.slice(offset - 1, limit ? offset - 1 + limit : undefined);
      const joined = selected.join("\n");
      const capped = truncateMiddle(joined, options.maxFileReadChars);
      return toolOkResult({
        path: target,
        total_lines: totalLines,
        start_line: offset,
        end_line: Math.min(totalLines, offset - 1 + selected.length),
        bytes: buffer.length,
        ...(capped.truncated ? { truncated: true, note: "Content truncated; use offset/limit to read specific ranges." } : {}),
        content: capped.text,
      });
    },
  };

  const writeFile: ToolDefinition = {
    name: "write_file",
    group: "workspace",
    description: [
      "Create or overwrite a UTF-8 text file with the given content (parent directories are created).",
      "For small changes to existing files prefer edit_file so unrelated content is untouched.",
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path, relative to the working directory or absolute." },
        content: { type: "string", description: "Full file content to write." },
        append: { type: "boolean", description: "Append instead of overwrite (default false)." },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    handler: async (args, runtime): Promise<ToolResult> => {
      const target = resolveWorkspacePath(runtime.cwd, args.path, options.env);
      const content = String(args.content ?? "");
      try {
        await fs.mkdir(path.dirname(target), { recursive: true });
        if (args.append === true) await fs.appendFile(target, content, "utf8");
        else await fs.writeFile(target, content, "utf8");
      } catch (err) {
        return toolErrorResult(`Cannot write ${target}: ${err instanceof Error ? err.message : String(err)}`);
      }
      return toolOkResult({ path: target, bytes: Buffer.byteLength(content, "utf8"), mode: args.append === true ? "append" : "overwrite" });
    },
  };

  const editFile: ToolDefinition = {
    name: "edit_file",
    group: "workspace",
    description: [
      "Replace an exact text snippet in a file. old_string must match the file content exactly once",
      "(including whitespace and indentation) unless replace_all is true. Read the file first and copy the snippet verbatim.",
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path, relative to the working directory or absolute." },
        old_string: { type: "string", description: "Exact text to find." },
        new_string: { type: "string", description: "Replacement text (may be empty to delete)." },
        replace_all: { type: "boolean", description: "Replace every occurrence (default false)." },
      },
      required: ["path", "old_string", "new_string"],
      additionalProperties: false,
    },
    handler: async (args, runtime): Promise<ToolResult> => {
      const target = resolveWorkspacePath(runtime.cwd, args.path, options.env);
      const oldString = String(args.old_string ?? "");
      const newString = String(args.new_string ?? "");
      if (!oldString) return toolErrorResult("old_string must not be empty");
      let text: string;
      try {
        text = await fs.readFile(target, "utf8");
      } catch (err) {
        return toolErrorResult(`Cannot read ${target}: ${err instanceof Error ? err.message : String(err)}`);
      }
      const occurrences = text.split(oldString).length - 1;
      if (occurrences === 0) {
        return toolErrorResult(`old_string was not found in ${target}. Read the file and copy the exact text (check whitespace and indentation).`);
      }
      if (occurrences > 1 && args.replace_all !== true) {
        return toolErrorResult(`old_string matches ${occurrences} places in ${target}; include more surrounding context to make it unique or set replace_all.`);
      }
      const updated = args.replace_all === true ? text.split(oldString).join(newString) : text.replace(oldString, () => newString);
      try {
        await fs.writeFile(target, updated, "utf8");
      } catch (err) {
        return toolErrorResult(`Cannot write ${target}: ${err instanceof Error ? err.message : String(err)}`);
      }
      return toolOkResult({ path: target, replacements: args.replace_all === true ? occurrences : 1 });
    },
  };

  const listDirectory: ToolDefinition = {
    name: "list_directory",
    group: "workspace",
    description: "List files and directories (recursively up to `depth`). Hidden entries and dependency folders are skipped unless requested.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory path (default: working directory)." },
        depth: { type: "integer", minimum: 1, maximum: 6, description: "Recursion depth (default 1)." },
        include_hidden: { type: "boolean", description: "Include dot-files and dot-directories (default false)." },
        max_entries: { type: "integer", minimum: 1, maximum: 5000, description: "Maximum entries to return (default 500)." },
      },
      additionalProperties: false,
    },
    handler: async (args, runtime): Promise<ToolResult> => {
      const target = resolveWorkspacePath(runtime.cwd, args.path, options.env);
      try {
        const stats = await fs.stat(target);
        if (!stats.isDirectory()) return toolErrorResult(`${target} is not a directory`);
      } catch (err) {
        return toolErrorResult(`Cannot list ${target}: ${err instanceof Error ? err.message : String(err)}`);
      }
      const depth = typeof args.depth === "number" ? Math.max(1, Math.floor(args.depth)) : 1;
      const includeHidden = args.include_hidden === true;
      const limit = typeof args.max_entries === "number" ? Math.max(1, Math.floor(args.max_entries)) : 500;
      const entries: string[] = [];
      const walkResult = await walk(
        target,
        { maxDepth: depth, includeHidden, ignoreDirs: includeHidden ? new Set() : DEFAULT_IGNORED_DIRS, limit, signal: runtime.signal },
        async (entry) => {
          entries.push(entry.dirent.isDirectory() ? `${entry.relative}/` : entry.relative);
        },
      );
      if (walkResult.aborted) return toolErrorResult("Listing cancelled: the run was aborted.", { path: target, entries, count: entries.length });
      return toolOkResult({
        path: target,
        entries,
        count: entries.length,
        ...(walkResult.limited ? { truncated: true, note: `Stopped after ${limit} entries; narrow the path or lower depth.` } : {}),
      });
    },
  };

  const searchFiles: ToolDefinition = {
    name: "search_files",
    group: "workspace",
    description: [
      "Search file contents with a regular expression (like grep -rn). Returns matching lines as path:line: text.",
      "Skips binary files, dependency folders and files over 2MB. Use `glob` to restrict file names (e.g. **/*.ts or src/**/*.{ts,tsx}).",
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "JavaScript regular expression to search for." },
        path: { type: "string", description: "Directory or file to search (default: working directory)." },
        glob: { type: "string", description: "Optional glob filter on the relative path, e.g. src/**/*.ts" },
        case_insensitive: { type: "boolean", description: "Case-insensitive matching (default false)." },
        max_results: { type: "integer", minimum: 1, maximum: 2000, description: "Maximum matches to return (default 200)." },
        include_hidden: { type: "boolean", description: "Search inside hidden files and directories (default false)." },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
    handler: async (args, runtime): Promise<ToolResult> => {
      const target = resolveWorkspacePath(runtime.cwd, args.path, options.env);
      const pattern = String(args.pattern ?? "");
      if (hasNestedQuantifier(pattern)) {
        return toolErrorResult(
          "Pattern contains a nested quantifier (a repeated group that itself repeats, e.g. (a+)+), which can hang the search on long lines. Rewrite it without nesting, e.g. use [^x]* or a single quantifier.",
        );
      }
      let regex: RegExp;
      try {
        regex = new RegExp(pattern, args.case_insensitive === true ? "i" : "");
      } catch (err) {
        return toolErrorResult(`Invalid regular expression: ${err instanceof Error ? err.message : String(err)}`);
      }
      const globRegex = typeof args.glob === "string" && args.glob.trim() ? globToRegExp(args.glob.trim()) : null;
      const maxResults = typeof args.max_results === "number" ? Math.max(1, Math.floor(args.max_results)) : 200;
      const includeHidden = args.include_hidden === true;
      const matches: string[] = [];
      let filesScanned = 0;
      let hitLimit = false;
      let aborted = false;

      const scanFile = async (filePath: string, relative: string) => {
        if (runtime.signal?.aborted) {
          aborted = true;
          return;
        }
        if (globRegex && !globRegex.test(relative.split(path.sep).join("/"))) return;
        let stats;
        try {
          stats = await fs.stat(filePath);
        } catch {
          return;
        }
        if (!stats.isFile() || stats.size > MAX_SEARCH_FILE_BYTES) return;
        const buffer = await fs.readFile(filePath).catch(() => null);
        if (!buffer || isBinary(buffer)) return;
        filesScanned += 1;
        const lines = buffer.toString("utf8").split(/\r?\n/);
        for (let index = 0; index < lines.length; index += 1) {
          if (index > 0 && index % 5000 === 0) {
            await yieldToEventLoop();
            if (runtime.signal?.aborted) {
              aborted = true;
              return;
            }
          }
          const line = lines[index]!;
          if (regex.test(line)) {
            matches.push(`${relative}:${index + 1}: ${line.length > 400 ? `${line.slice(0, 400)}…` : line}`);
            if (matches.length >= maxResults) {
              hitLimit = true;
              return;
            }
          }
        }
      };

      let rootStats;
      try {
        rootStats = await fs.stat(target);
      } catch (err) {
        return toolErrorResult(`Cannot search ${target}: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (rootStats.isFile()) {
        await scanFile(target, path.basename(target));
      } else {
        const walkResult = await walk(
          target,
          { maxDepth: 64, includeHidden, ignoreDirs: includeHidden ? new Set([".git"]) : DEFAULT_IGNORED_DIRS, limit: 200_000, signal: runtime.signal },
          async (entry) => {
            if (entry.dirent.isFile()) await scanFile(entry.path, entry.relative);
            return hitLimit || aborted;
          },
        );
        aborted = aborted || walkResult.aborted;
      }
      if (aborted) {
        return toolErrorResult("Search cancelled: the run was aborted.", { path: target, files_scanned: filesScanned, match_count: matches.length, matches });
      }
      const note = hitLimit
        ? `Stopped at ${maxResults} matches; refine the pattern or path.`
        : globRegex && filesScanned === 0
          ? `No files matched the glob "${String(args.glob).trim()}" (or all matching files were binary or over 2MB); check the pattern. Globs support *, **, ? and {a,b} groups on paths relative to the searched directory.`
          : null;
      return {
        content: safeJsonStringify({
          ok: true,
          path: target,
          files_scanned: filesScanned,
          match_count: matches.length,
          ...(hitLimit ? { truncated: true } : {}),
          ...(note ? { note } : {}),
          matches,
        }),
      };
    },
  };

  return [readFile, writeFile, editFile, listDirectory, searchFiles];
}
