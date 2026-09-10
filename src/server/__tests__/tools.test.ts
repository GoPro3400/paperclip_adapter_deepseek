import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createFileTools, globToRegExp } from "../tools/files.js";
import { buildPaperclipRequestUrl, createPaperclipApiTool } from "../tools/paperclip-api.js";
import { ToolRegistry, type ToolRuntime } from "../tools/registry.js";
import { createShellTool } from "../tools/shell.js";
import { buildSkillCatalog, createLoadSkillTool, parseSkillFrontmatter } from "../tools/skills.js";
import { SecretRedactor, truncateMiddle } from "../text.js";

let tmp: string;
const runtime = (): ToolRuntime => ({ cwd: tmp, maxOutputChars: 4000, redact: (text) => text, log: async () => undefined });

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "deepseek-tools-"));
  await fs.mkdir(path.join(tmp, "src", "nested"), { recursive: true });
  await fs.writeFile(path.join(tmp, "src", "a.ts"), "const a = 1;\nexport const answer = 42;\n");
  await fs.writeFile(path.join(tmp, "src", "nested", "b.ts"), "// nested\nconst answer = 'b';\n");
  await fs.writeFile(path.join(tmp, "README.md"), "# Hello\n");
  await fs.mkdir(path.join(tmp, "node_modules", "dep"), { recursive: true });
  await fs.writeFile(path.join(tmp, "node_modules", "dep", "index.js"), "answer");
});

afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

function registryWith(tools: ReturnType<typeof createFileTools>): ToolRegistry {
  const reg = new ToolRegistry({ strict: false });
  for (const tool of tools) reg.register(tool);
  return reg;
}

describe("file tools", () => {
  const reg = registryWith(createFileTools({ maxFileReadChars: 10_000 }));

  it("reads, edits and writes files", async () => {
    const read = await reg.invoke("read_file", JSON.stringify({ path: "src/a.ts" }), runtime());
    const readBody = JSON.parse(read.result.content);
    expect(readBody.ok).toBe(true);
    expect(readBody.total_lines).toBe(3);
    expect(readBody.content).toContain("answer = 42");

    const ranged = await reg.invoke("read_file", JSON.stringify({ path: "src/a.ts", offset: 2, limit: 1 }), runtime());
    expect(JSON.parse(ranged.result.content).content).toBe("export const answer = 42;");

    const edit = await reg.invoke("edit_file", JSON.stringify({ path: "src/a.ts", old_string: "answer = 42", new_string: "answer = 43" }), runtime());
    expect(JSON.parse(edit.result.content)).toMatchObject({ ok: true, replacements: 1 });
    expect(await fs.readFile(path.join(tmp, "src", "a.ts"), "utf8")).toContain("answer = 43");

    const missing = await reg.invoke("edit_file", JSON.stringify({ path: "src/a.ts", old_string: "nope", new_string: "x" }), runtime());
    expect(missing.result.isError).toBe(true);
    expect(missing.result.content).toContain("was not found");

    const write = await reg.invoke("write_file", JSON.stringify({ path: "out/new.txt", content: "line1\nline2\n" }), runtime());
    expect(JSON.parse(write.result.content).bytes).toBe(12);
    expect(await fs.readFile(path.join(tmp, "out", "new.txt"), "utf8")).toBe("line1\nline2\n");
  });

  it("lists and searches while skipping dependency folders", async () => {
    const listed = await reg.invoke("list_directory", JSON.stringify({ depth: 3 }), runtime());
    const entries = JSON.parse(listed.result.content).entries as string[];
    expect(entries).toContain("src/");
    expect(entries).toContain(path.join("src", "nested", "b.ts"));
    expect(entries.filter((entry) => entry.startsWith("node_modules"))).toEqual(["node_modules/"]);

    const search = await reg.invoke("search_files", JSON.stringify({ pattern: "answer", glob: "src/**/*.ts" }), runtime());
    const body = JSON.parse(search.result.content);
    expect(body.match_count).toBe(2);
    expect(body.matches[0]).toMatch(/src[\\/]a\.ts:2: export const answer = 43;/);

    const invalid = await reg.invoke("search_files", JSON.stringify({ pattern: "(" }), runtime());
    expect(invalid.result.isError).toBe(true);
  });

  it("converts globs", () => {
    expect(globToRegExp("src/**/*.ts").test("src/nested/b.ts")).toBe(true);
    expect(globToRegExp("*.md").test("README.md")).toBe(true);
    expect(globToRegExp("*.md").test("docs/README.md")).toBe(false);
  });

  it("rejects schema violations before running handlers", async () => {
    const outcome = await reg.invoke("read_file", JSON.stringify({ path: 1 }), runtime());
    expect(outcome.validationFailed).toBe(true);
    expect(outcome.result.content).toContain("path: expected string");
  });
});

describe("run_shell", () => {
  const reg = registryWith([createShellTool({ env: { MY_TOKEN: "secret-value-123" }, defaultTimeoutSec: 5, maxTimeoutSec: 10, graceSec: 1 })]);

  it("runs commands with exit codes and captures output", async () => {
    const ok = await reg.invoke("run_shell", JSON.stringify({ command: "echo hello && echo err 1>&2" }), runtime());
    const body = JSON.parse(ok.result.content);
    expect(body.ok).toBe(true);
    expect(body.exit_code).toBe(0);
    expect(body.stdout.trim()).toBe("hello");
    expect(body.stderr.trim()).toBe("err");

    const failing = await reg.invoke("run_shell", JSON.stringify({ command: "exit 3" }), runtime());
    expect(failing.result.isError).toBe(true);
    expect(JSON.parse(failing.result.content).exit_code).toBe(3);
  });

  it("enforces timeouts and redacts secrets", async () => {
    const timedOut = await reg.invoke("run_shell", JSON.stringify({ command: "sleep 5", timeout_sec: 1 }), runtime());
    const body = JSON.parse(timedOut.result.content);
    expect(body.timed_out).toBe(true);
    expect(timedOut.result.isError).toBe(true);

    const redactor = new SecretRedactor();
    redactor.add("secret-value-123");
    const leaked = await reg.invoke("run_shell", JSON.stringify({ command: "echo $MY_TOKEN" }), { ...runtime(), redact: (text) => redactor.redact(text) });
    expect(leaked.result.content).toContain("***REDACTED***");
    expect(leaked.result.content).not.toContain("secret-value-123");
  });
});

describe("paperclip_api tool", () => {
  it("builds URLs and injects auth headers", async () => {
    expect(buildPaperclipRequestUrl("http://localhost:3100/api/", "/api/agents/me", null)).toBe("http://localhost:3100/api/agents/me");
    expect(buildPaperclipRequestUrl("http://localhost:3100", "issues/abc", { status: ["todo", "done"], limit: 5 })).toBe(
      "http://localhost:3100/api/issues/abc?status=todo%2Cdone&limit=5",
    );
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      if (String(url).includes("checkout")) return new Response('{"error":"conflict"}', { status: 409 });
      return new Response('{"id":"agent-1"}', { status: 200, headers: { "content-type": "application/json" } });
    });
    const tool = createPaperclipApiTool({ apiUrl: "http://localhost:3100", apiKey: "jwt-token", runId: "run-1", agentId: "agent-1", companyId: "co", fetchImpl: fetchImpl as unknown as typeof fetch });
    const reg = new ToolRegistry({ strict: false });
    reg.register(tool);
    const me = await reg.invoke("paperclip_api", JSON.stringify({ method: "GET", path: "/api/agents/me" }), runtime());
    expect(JSON.parse(me.result.content)).toMatchObject({ ok: true, status: 200, body: { id: "agent-1" } });
    const getHeaders = calls[0]!.init.headers as Record<string, string>;
    expect(getHeaders.authorization).toBe("Bearer jwt-token");
    expect(getHeaders["x-paperclip-run-id"]).toBeUndefined();

    const checkout = await reg.invoke("paperclip_api", JSON.stringify({ method: "POST", path: "/api/issues/i1/checkout", body: { agentId: "agent-1" } }), runtime());
    expect(checkout.result.isError).toBe(true);
    const body = JSON.parse(checkout.result.content);
    expect(body.status).toBe(409);
    expect(body.hint).toContain("Do not retry");
    const postHeaders = calls[1]!.init.headers as Record<string, string>;
    expect(postHeaders["x-paperclip-run-id"]).toBe("run-1");
    expect(calls[1]!.init.body).toBe('{"agentId":"agent-1"}');
  });
});

describe("skills", () => {
  it("parses frontmatter and loads bundled or configured skills", async () => {
    expect(parseSkillFrontmatter("---\nname: demo\ndescription: >\n  Multi line\n  description.\n---\n# Demo")).toEqual({ name: "demo", description: "Multi line description." });
    const skillsDir = path.join(tmp, "skills");
    await fs.mkdir(path.join(skillsDir, "demo", "references"), { recursive: true });
    await fs.writeFile(path.join(skillsDir, "demo", "SKILL.md"), "---\nname: demo\ndescription: Demo skill\n---\nDo demo things.");
    await fs.writeFile(path.join(skillsDir, "demo", "references", "api.md"), "# API");
    const catalog = await buildSkillCatalog({ config: {}, moduleDir: tmp, extraSkillsDir: skillsDir, includeBundled: false });
    expect(catalog.map((entry) => entry.name)).toEqual(["demo"]);
    const reg = new ToolRegistry({ strict: false });
    reg.register(createLoadSkillTool(catalog, 10_000));
    const loaded = await reg.invoke("load_skill", JSON.stringify({ name: "demo" }), runtime());
    expect(JSON.parse(loaded.result.content).content).toContain("Do demo things");
    const ref = await reg.invoke("load_skill", JSON.stringify({ name: "demo", file: "references/api.md" }), runtime());
    expect(JSON.parse(ref.result.content).content).toBe("# API");
    const escape = await reg.invoke("load_skill", JSON.stringify({ name: "demo", file: "../../README.md" }), runtime());
    expect(escape.result.isError).toBe(true);
  });
});

describe("text helpers", () => {
  it("truncates in the middle keeping head and tail", () => {
    const text = `${"a".repeat(500)}MIDDLE${"z".repeat(500)}`;
    const result = truncateMiddle(text, 200);
    expect(result.truncated).toBe(true);
    expect(result.text.startsWith("aaaa")).toBe(true);
    expect(result.text.endsWith("zzzz")).toBe(true);
    expect(result.text).toContain("chars omitted");
  });
});
