/**
 * load_skill: on-demand access to Paperclip skills (SKILL.md and reference
 * files). Skills come from three places, merged in this order:
 *   1. `config.paperclipRuntimeSkills` — entries the Paperclip server prepared
 *      for this agent (company-managed skills with on-disk sources)
 *   2. `config.skillsDir` — an operator-provided directory of skill folders
 *   3. the skills bundled with this package (`<package>/skills`)
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  isPaperclipSkillSourceMissing,
  readPaperclipRuntimeSkillEntries,
  type PaperclipSkillEntry,
} from "@paperclipai/adapter-utils/server-utils";
import type { ToolDefinition, ToolResult } from "./registry.js";
import { toolErrorResult, toolOkResult } from "./registry.js";
import { truncateMiddle } from "../text.js";

export interface SkillCatalogEntry {
  name: string;
  key: string;
  description: string;
  sourceDir: string;
  origin: "paperclip" | "config" | "bundled";
}

export function parseSkillFrontmatter(markdown: string): { name: string | null; description: string | null } {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return { name: null, description: null };
  const block = match[1] ?? "";
  const lines = block.split(/\r?\n/);
  let name: string | null = null;
  let description: string | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const nameMatch = line.match(/^name:\s*(.+)$/);
    if (nameMatch) {
      name = nameMatch[1]!.trim().replace(/^["']|["']$/g, "");
      continue;
    }
    const descMatch = line.match(/^description:\s*(.*)$/);
    if (descMatch) {
      const inline = descMatch[1]!.trim();
      if (inline && inline !== ">" && inline !== "|" && inline !== ">-" && inline !== "|-") {
        description = inline.replace(/^["']|["']$/g, "");
        continue;
      }
      const collected: string[] = [];
      for (let next = index + 1; next < lines.length; next += 1) {
        const candidate = lines[next]!;
        if (!/^\s+/.test(candidate)) break;
        collected.push(candidate.trim());
      }
      description = collected.join(" ").trim();
    }
  }
  return { name, description };
}

export function bundledSkillsDir(): string {
  // dist/server/tools/skills.js -> <package root>/skills
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "..", "skills");
}

async function readSkillDirs(root: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(root, entry.name));
  } catch {
    return [];
  }
}

async function describeSkillDir(sourceDir: string, origin: SkillCatalogEntry["origin"], keyHint?: string): Promise<SkillCatalogEntry | null> {
  let markdown: string;
  try {
    markdown = await fs.readFile(path.join(sourceDir, "SKILL.md"), "utf8");
  } catch {
    return null;
  }
  const frontmatter = parseSkillFrontmatter(markdown);
  const dirName = path.basename(sourceDir);
  return {
    name: frontmatter.name ?? dirName,
    key: keyHint ?? dirName,
    description: frontmatter.description ?? "",
    sourceDir,
    origin,
  };
}

export async function buildSkillCatalog(input: {
  config: Record<string, unknown>;
  moduleDir: string;
  extraSkillsDir?: string;
  includeBundled?: boolean;
}): Promise<SkillCatalogEntry[]> {
  const byName = new Map<string, SkillCatalogEntry>();
  const add = (entry: SkillCatalogEntry | null) => {
    if (!entry) return;
    const key = entry.name.toLowerCase();
    if (!byName.has(key)) byName.set(key, entry);
  };

  let runtimeEntries: PaperclipSkillEntry[] = [];
  try {
    runtimeEntries = await readPaperclipRuntimeSkillEntries(input.config, input.moduleDir);
  } catch {
    runtimeEntries = [];
  }
  for (const entry of runtimeEntries) {
    if (isPaperclipSkillSourceMissing(entry)) continue;
    add(await describeSkillDir(entry.source, "paperclip", entry.key));
  }
  if (input.extraSkillsDir) {
    for (const dir of await readSkillDirs(input.extraSkillsDir)) add(await describeSkillDir(dir, "config"));
  }
  if (input.includeBundled !== false) {
    for (const dir of await readSkillDirs(bundledSkillsDir())) add(await describeSkillDir(dir, "bundled"));
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function findSkill(catalog: SkillCatalogEntry[], name: string): SkillCatalogEntry | null {
  const normalized = name.trim().toLowerCase();
  if (!normalized) return null;
  return (
    catalog.find((entry) => entry.name.toLowerCase() === normalized) ??
    catalog.find((entry) => entry.key.toLowerCase() === normalized) ??
    catalog.find((entry) => entry.key.toLowerCase().split("/").pop() === normalized) ??
    null
  );
}

export function createLoadSkillTool(catalog: SkillCatalogEntry[], maxChars: number): ToolDefinition {
  return {
    name: "load_skill",
    group: "skills",
    description: [
      "Load the full instructions of an available skill (its SKILL.md) or one of its reference files.",
      "Skills are procedures you should read before doing specialised work; the `paperclip` skill documents the complete control-plane API",
      "(interactions, documents, approvals, routines, artifacts). Call with file omitted to get SKILL.md, or file=\"references/<name>.md\".",
      catalog.length > 0
        ? `Available skills: ${catalog.map((entry) => entry.name).join(", ")}.`
        : "No skills are currently available.",
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Skill name, e.g. paperclip" },
        file: { type: "string", description: "Optional relative file inside the skill folder (default SKILL.md)." },
      },
      required: ["name"],
      additionalProperties: false,
    },
    handler: async (args): Promise<ToolResult> => {
      const skill = findSkill(catalog, String(args.name ?? ""));
      if (!skill) {
        return toolErrorResult(`Unknown skill "${String(args.name ?? "")}". Available: ${catalog.map((entry) => entry.name).join(", ") || "(none)"}`);
      }
      const relative = typeof args.file === "string" && args.file.trim() ? args.file.trim() : "SKILL.md";
      const target = path.resolve(skill.sourceDir, relative);
      if (!target.startsWith(path.resolve(skill.sourceDir) + path.sep) && target !== path.resolve(skill.sourceDir)) {
        return toolErrorResult("file must stay inside the skill folder");
      }
      let content: string;
      try {
        content = await fs.readFile(target, "utf8");
      } catch {
        const files = await listSkillFiles(skill.sourceDir);
        return toolErrorResult(`File ${relative} not found in skill ${skill.name}`, { availableFiles: files });
      }
      const capped = truncateMiddle(content, maxChars);
      const files = await listSkillFiles(skill.sourceDir);
      return toolOkResult({
        skill: skill.name,
        file: relative,
        path: target,
        files,
        ...(capped.truncated ? { truncated: true } : {}),
        content: capped.text,
      });
    },
  };
}

async function listSkillFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const queue = [root];
  while (queue.length > 0 && out.length < 200) {
    const dir = queue.shift()!;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) queue.push(full);
      else out.push(path.relative(root, full));
    }
  }
  return out.sort();
}
