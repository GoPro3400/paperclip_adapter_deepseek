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
}

const DEFAULT_IGNORED_DIRS = new Set([".git", "node_modules", ".pnpm-store", ".venv", "venv", "__pycache__", ".cache", "dist", "build", ".next", ".turbo"]);
const MAX_SEARCH_FILE_BYTES = 2 * 1024 * 1024;

export function resolveWorkspacePath(cwd: string, raw: unknown): string {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) return cwd;
  const expanded = value === "~" ? os.homedir() : value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;
  return path.resolve(cwd, expanded);
}

function isBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8000));
  for (const byte of sample) {
    if (byte === 0) return true;
  }
  return false;
}

export function globToRegExp(glob: string): RegExp {
  let out = "^";
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
    } else if (".+^${}()|[]\\".includes(char)) {
      out += `\\${char}`;
    } else {
      out += char;
    }
  }
  return new RegExp(`${out}$`);
}

async function walk(
  root: string,
  options: { maxDepth: number; includeHidden: boolean; ignoreDirs: Set<string>; limit: number },
  visit: (entry: { path: string; relative: string; dirent: Dirent; depth: number }) => Promise<boolean | void>,
): Promise<{ count: number; limited: boolean }> {
  let count = 0;
  let limited = false;
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (queue.length > 0) {
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
        return { count, limited };
      }
      const stop = await visit({ path: fullPath, relative, dirent, depth: current.depth + 1 });
      count += 1;
      if (stop === true) return { count, limited };
      if (dirent.isDirectory() && current.depth + 1 < options.maxDepth && !options.ignoreDirs.has(dirent.name)) {
        queue.push({ dir: fullPath, depth: current.depth + 1 });
      }
    }
  }
  return { count, limited };
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
      const target = resolveWorkspacePath(runtime.cwd, args.path);
      let buffer: Buffer;
      try {
        const stats = await fs.stat(target);
        if (stats.isDirectory()) return toolErrorResult(`${target} is a directory; use list_directory`);
        buffer = await fs.readFile(target);
      } catch (err) {
        return toolErrorResult(`Cannot read ${target}: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (isBinary(buffer)) return toolErrorResult(`${target} looks like a binary file (${buffer.length} bytes)`);
      const text = buffer.toString("utf8");
      const lines = text.split(/\r?\n/);
      const totalLines = lines.length;
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
      const target = resolveWorkspacePath(runtime.cwd, args.path);
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
      const target = resolveWorkspacePath(runtime.cwd, args.path);
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
      const target = resolveWorkspacePath(runtime.cwd, args.path);
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
        { maxDepth: depth, includeHidden, ignoreDirs: includeHidden ? new Set() : DEFAULT_IGNORED_DIRS, limit },
        async (entry) => {
          entries.push(entry.dirent.isDirectory() ? `${entry.relative}/` : entry.relative);
        },
      );
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
      "Skips binary files, dependency folders and files over 2MB. Use `glob` to restrict file names (e.g. **/*.ts).",
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
      const target = resolveWorkspacePath(runtime.cwd, args.path);
      let regex: RegExp;
      try {
        regex = new RegExp(String(args.pattern ?? ""), args.case_insensitive === true ? "i" : "");
      } catch (err) {
        return toolErrorResult(`Invalid regular expression: ${err instanceof Error ? err.message : String(err)}`);
      }
      const globRegex = typeof args.glob === "string" && args.glob.trim() ? globToRegExp(args.glob.trim()) : null;
      const maxResults = typeof args.max_results === "number" ? Math.max(1, Math.floor(args.max_results)) : 200;
      const includeHidden = args.include_hidden === true;
      const matches: string[] = [];
      let filesScanned = 0;
      let hitLimit = false;

      const scanFile = async (filePath: string, relative: string) => {
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
        await walk(
          target,
          { maxDepth: 64, includeHidden, ignoreDirs: includeHidden ? new Set([".git"]) : DEFAULT_IGNORED_DIRS, limit: 200_000 },
          async (entry) => {
            if (entry.dirent.isFile()) await scanFile(entry.path, entry.relative);
            return hitLimit;
          },
        );
      }
      return {
        content: safeJsonStringify({
          ok: true,
          path: target,
          files_scanned: filesScanned,
          match_count: matches.length,
          ...(hitLimit ? { truncated: true, note: `Stopped at ${maxResults} matches; refine the pattern or path.` } : {}),
          matches,
        }),
      };
    },
  };

  return [readFile, writeFile, editFile, listDirectory, searchFiles];
}
