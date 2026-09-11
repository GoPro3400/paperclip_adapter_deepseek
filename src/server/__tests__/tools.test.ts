import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RuntimeToolAccess } from "../compat.js";
import { listSkills } from "../index.js";
import { buildSystemPrompt, renderHeartbeatFacts } from "../prompt.js";
import { createConnectionTools } from "../tools/connections.js";
import { MAX_READ_FILE_BYTES, createFileTools, globToRegExp, hasNestedQuantifier, resolveWorkspacePath } from "../tools/files.js";
import { RUN_DISPOSITIONS, createFinishRunTool } from "../tools/finish.js";
import { buildPaperclipRequestUrl, createPaperclipApiTool, substitutePathPlaceholders } from "../tools/paperclip-api.js";
import { ToolRegistry, type ToolRuntime } from "../tools/registry.js";
import { StreamCapture, buildShellEnv, createShellTool, renderCapturedStream } from "../tools/shell.js";
import { buildSkillCatalog, createLoadSkillTool, parseSkillFrontmatter } from "../tools/skills.js";
import { SecretRedactor, TRUNCATION_MARKER, truncateMiddle } from "../text.js";

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
    expect(readBody.total_lines).toBe(2);
    expect(readBody.end_line).toBe(2);
    expect(readBody.content).toBe("const a = 1;\nexport const answer = 42;\n");
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

  it("redacts secrets in their JSON-escaped spelling inside event lines", () => {
    const redactor = new SecretRedactor();
    const secret = 'p"ss\\wo\nrd1';
    redactor.addFromEnv({ DB_PASSWORD: secret, PLAIN: "not-a-secret-value", SHORT_KEY: "abc" });
    const line = JSON.stringify({ type: "deepseek.tool_call", args: { command: `echo ${secret}` } });
    expect(redactor.redact(line)).not.toContain(JSON.stringify(secret).slice(1, -1));
    expect(redactor.redact(line)).toContain("***REDACTED***");
    expect(redactor.redact(`raw ${secret} here`)).toBe("raw ***REDACTED*** here");
    expect(redactor.redact("abc not-a-secret-value")).toBe("abc not-a-secret-value");
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

// ---------------------------------------------------------------------------
// Fixes from the tools review (shell capture/exit handling, env isolation,
// file tool guards, paperclip_api placeholders, finish_run dispositions,
// connection tool timeouts, skill symlink guard and desired-skill filtering).
// ---------------------------------------------------------------------------

describe("run_shell hardening", () => {
  const reg = registryWith([createShellTool({ env: { MY_TOKEN: "secret-value-123" }, defaultTimeoutSec: 5, maxTimeoutSec: 10, graceSec: 1 })]);

  it("returns when the shell exits even if a detached helper still holds stdout, without reporting a timeout", async () => {
    const started = Date.now();
    const held = await reg.invoke("run_shell", JSON.stringify({ command: "sleep 3 & echo started", timeout_sec: 5 }), runtime());
    const body = JSON.parse(held.result.content);
    expect(body.ok).toBe(true);
    expect(body.exit_code).toBe(0);
    expect(body.timed_out).toBe(false);
    expect(body.stdout.trim()).toBe("started");
    expect(Date.now() - started).toBeLessThan(2500);

    const redirected = await reg.invoke("run_shell", JSON.stringify({ command: "nohup sleep 3 > /dev/null 2>&1 < /dev/null & echo bg", timeout_sec: 5 }), runtime());
    expect(JSON.parse(redirected.result.content)).toMatchObject({ ok: true, exit_code: 0, timed_out: false });
  });

  it("keeps multibyte UTF-8 intact across pipe chunk boundaries and keeps the real head of oversized output", async () => {
    // 1 ASCII byte followed by 70 000 two-byte characters: every 64 KiB pipe read ends mid-character.
    const utf8 = await reg.invoke("run_shell", JSON.stringify({ command: "printf 'a'; yes 'é' | head -n 70000 | tr -d '\\n'" }), runtime());
    const utf8Body = JSON.parse(utf8.result.content);
    expect(utf8Body.exit_code).toBe(0);
    expect(utf8Body.stdout).not.toContain("�");
    expect(utf8Body.stdout.startsWith("aéé")).toBe(true);
    expect(utf8Body.stdout.endsWith("éé")).toBe(true);
    expect(utf8Body.truncated).toBe(true);

    const big = await reg.invoke("run_shell", JSON.stringify({ command: 'for i in $(seq 1 30000); do echo "line-$i"; done' }), runtime());
    const bigBody = JSON.parse(big.result.content);
    expect(bigBody.stdout.startsWith("line-1\nline-2\n")).toBe(true);
    expect(bigBody.stdout.endsWith("line-30000\n")).toBe(true);
    expect(bigBody.stdout.split(TRUNCATION_MARKER).length - 1).toBe(2);
    expect(bigBody.stdout.length).toBeLessThanOrEqual(2000);
    expect(String(bigBody.note)).toContain("capture buffer");
  });

  it("keeps the head and tail while capturing and renders a single marker", () => {
    const capture = new StreamCapture(1000);
    for (let index = 0; index < 500; index += 1) capture.append(`chunk-${index}\n`);
    const snapshot = capture.snapshot();
    expect(snapshot.head.startsWith("chunk-0\nchunk-1\n")).toBe(true);
    expect(snapshot.tail.endsWith("chunk-499\n")).toBe(true);
    expect(snapshot.omittedChars).toBeGreaterThan(0);
    const rendered = renderCapturedStream(snapshot, 300);
    expect(rendered.truncated).toBe(true);
    expect(rendered.text.startsWith("chunk-0\n")).toBe(true);
    expect(rendered.text.endsWith("chunk-499\n")).toBe(true);
    expect(rendered.text.length).toBeLessThanOrEqual(300);
    const small = new StreamCapture(1000);
    small.append("hello");
    expect(renderCapturedStream(small.snapshot(), 300)).toEqual({ text: "hello", truncated: false });
  });

  it("drops the DeepSeek key inherited from the server process unless exposed, and never PAPERCLIP_* server variables", () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "sk-from-server-process");
    vi.stubEnv("PAPERCLIP_JWT_SECRET", "server-secret");
    vi.stubEnv("SOME_SERVER_VAR", "kept");
    try {
      const isolated = buildShellEnv({ PAPERCLIP_API_KEY: "run-token" }, ["DEEPSEEK_API_KEY"]);
      expect(isolated.DEEPSEEK_API_KEY).toBeUndefined();
      expect(isolated.PAPERCLIP_JWT_SECRET).toBeUndefined();
      expect(isolated.PAPERCLIP_API_KEY).toBe("run-token");
      expect(isolated.SOME_SERVER_VAR).toBe("kept");
      expect(isolated.CI).toBe("1");
      // Explicit run env wins over the drop list (operator opted in through config.env).
      expect(buildShellEnv({ DEEPSEEK_API_KEY: "sk-explicit" }, ["DEEPSEEK_API_KEY"]).DEEPSEEK_API_KEY).toBe("sk-explicit");
      expect(buildShellEnv({}, []).DEEPSEEK_API_KEY).toBe("sk-from-server-process");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("documents background helpers instead of recommending bare nohup", () => {
    const tool = createShellTool({ env: {}, defaultTimeoutSec: 5, maxTimeoutSec: 10, graceSec: 1 });
    expect(tool.description).not.toContain("never start long-lived servers without");
    expect(tool.description).toContain("2>&1 < /dev/null &");
    expect(tool.description).toContain("issue-workspaces.md");
  });
});

describe("file tool hardening", () => {
  const reg = registryWith(createFileTools({ maxFileReadChars: 10_000, env: { PAPERCLIP_RUN_SCRATCH_DIR: "/scratch/run-1" } }));

  it("expands only ~, $HOME and PAPERCLIP_* run variables in paths", () => {
    const env = { PAPERCLIP_RUN_SCRATCH_DIR: "/scratch/run-1", HOME: "/home/agent" };
    expect(resolveWorkspacePath("/work", "$PAPERCLIP_RUN_SCRATCH_DIR/notes.md", env)).toBe(path.resolve("/scratch/run-1/notes.md"));
    expect(resolveWorkspacePath("/work", "${PAPERCLIP_RUN_SCRATCH_DIR}/plan.md", env)).toBe(path.resolve("/scratch/run-1/plan.md"));
    expect(resolveWorkspacePath("/work", "$HOME/x", env)).toBe(path.resolve("/home/agent/x"));
    expect(resolveWorkspacePath("/work", "$PAPERCLIP_UNSET/x", env)).toBe(path.resolve("/work/$PAPERCLIP_UNSET/x"));
    expect(resolveWorkspacePath("/work", "$PATH/x", env)).toBe(path.resolve("/work/$PATH/x"));
    expect(resolveWorkspacePath("/work", "~/x", env)).toBe(path.join(os.homedir(), "x"));
  });

  it("reports total_lines without the trailing-newline segment and rejects oversized files", async () => {
    await fs.writeFile(path.join(tmp, "two.txt"), "a\nb\n");
    const two = JSON.parse((await reg.invoke("read_file", JSON.stringify({ path: "two.txt" }), runtime())).result.content);
    expect(two).toMatchObject({ total_lines: 2, end_line: 2, content: "a\nb\n" });
    await fs.writeFile(path.join(tmp, "empty.txt"), "");
    expect(JSON.parse((await reg.invoke("read_file", JSON.stringify({ path: "empty.txt" }), runtime())).result.content).total_lines).toBe(0);
    await fs.writeFile(path.join(tmp, "one.txt"), "only");
    expect(JSON.parse((await reg.invoke("read_file", JSON.stringify({ path: "one.txt" }), runtime())).result.content)).toMatchObject({ total_lines: 1, content: "only" });

    const huge = path.join(tmp, "huge.log");
    await fs.writeFile(huge, "");
    await fs.truncate(huge, MAX_READ_FILE_BYTES + 1);
    const rejected = await reg.invoke("read_file", JSON.stringify({ path: "huge.log" }), runtime());
    expect(rejected.result.isError).toBe(true);
    expect(rejected.result.content).toContain("too large");
    expect(rejected.result.content).toContain("sed -n");
  });

  it("supports brace groups in globs and explains an empty glob match", async () => {
    expect(globToRegExp("**/*.{ts,tsx}").test("src/nested/b.tsx")).toBe(true);
    expect(globToRegExp("**/*.{ts,tsx}").test("a.ts")).toBe(true);
    expect(globToRegExp("**/*.{ts,tsx}").test("a.js")).toBe(false);
    expect(globToRegExp("src/**/*.{js,jsx}").test("src/x/y.jsx")).toBe(true);
    const found = JSON.parse((await reg.invoke("search_files", JSON.stringify({ pattern: "answer", glob: "**/*.{ts,tsx}" }), runtime())).result.content);
    expect(found.match_count).toBe(2);
    const none = JSON.parse((await reg.invoke("search_files", JSON.stringify({ pattern: "answer", glob: "**/*.{py,rb}" }), runtime())).result.content);
    expect(none.match_count).toBe(0);
    expect(none.files_scanned).toBe(0);
    expect(String(none.note)).toContain("No files matched the glob");
  });

  it("rejects nested quantifiers and honours the abort signal", async () => {
    expect(hasNestedQuantifier("(a+)+$")).toBe(true);
    expect(hasNestedQuantifier("(\\d*)*")).toBe(true);
    expect(hasNestedQuantifier("(foo|bar)+")).toBe(false);
    expect(hasNestedQuantifier("[a-z]+\\.(ts|js)")).toBe(false);
    expect(hasNestedQuantifier("(\\+)+")).toBe(false);
    const rejected = await reg.invoke("search_files", JSON.stringify({ pattern: "(a+)+$" }), runtime());
    expect(rejected.result.isError).toBe(true);
    expect(rejected.result.content).toContain("nested quantifier");

    const controller = new AbortController();
    controller.abort();
    const cancelled = await reg.invoke("search_files", JSON.stringify({ pattern: "answer" }), { ...runtime(), signal: controller.signal });
    expect(cancelled.result.isError).toBe(true);
    expect(cancelled.result.content).toContain("cancelled");
    const listing = await reg.invoke("list_directory", JSON.stringify({ depth: 3 }), { ...runtime(), signal: controller.signal });
    expect(listing.result.isError).toBe(true);
  });
});

describe("paperclip_api hardening", () => {
  it("fills known placeholders, rejects unresolved ones, keeps paths under /api and rejects object query values", async () => {
    expect(substitutePathPlaceholders("/api/issues/$PAPERCLIP_TASK_ID/interactions", { taskId: "issue-9", agentId: "agent-1", companyId: "co-1" })).toEqual({
      path: "/api/issues/issue-9/interactions",
      unresolved: [],
    });
    expect(substitutePathPlaceholders("/api/agents/${PAPERCLIP_AGENT_ID}/skills", { taskId: null, agentId: "agent-1", companyId: "co-1" }).path).toBe("/api/agents/agent-1/skills");
    expect(substitutePathPlaceholders("/api/companies/{companyId}/issues", { taskId: null, agentId: "agent-1", companyId: "co-1" }).path).toBe("/api/companies/co-1/issues");
    expect(substitutePathPlaceholders("/api/issues/{issueId}/comments", { taskId: "issue-9", agentId: "a", companyId: "c" }).unresolved).toEqual(["{issueId}"]);
    expect(substitutePathPlaceholders("/api/issues/$PAPERCLIP_TASK_ID", { taskId: null, agentId: "a", companyId: "c" }).unresolved).toEqual(["$PAPERCLIP_TASK_ID"]);
    expect(substitutePathPlaceholders("/api/issues/:issueId", { taskId: null, agentId: "a", companyId: "c" }).unresolved).toEqual([":issueId"]);
    expect(substitutePathPlaceholders("/api/issues/PAP-12/comments?after=c1", { taskId: null, agentId: "a", companyId: "c" }).unresolved).toEqual([]);

    expect(() => buildPaperclipRequestUrl("http://h:3100", "/api/../../x", null)).toThrow(/stay under \/api/);
    expect(() => buildPaperclipRequestUrl("http://h:3100", "/api/issues", { filter: { status: "todo" } })).toThrow(/nested objects/);
    expect(buildPaperclipRequestUrl("http://h:3100", "/api/issues", { status: "todo", limit: 5, open: true })).toBe("http://h:3100/api/issues?status=todo&limit=5&open=true");

    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      calls.push(String(url));
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    });
    const tool = createPaperclipApiTool({ apiUrl: "http://localhost:3100", apiKey: "jwt", runId: "run-1", agentId: "agent-1", companyId: "co-1", taskId: "issue-9", fetchImpl: fetchImpl as unknown as typeof fetch });
    const reg = new ToolRegistry({ strict: false });
    reg.register(tool);
    const ok = await reg.invoke("paperclip_api", JSON.stringify({ method: "POST", path: "/api/issues/$PAPERCLIP_TASK_ID/interactions", body: { kind: "ask_user_questions" } }), runtime());
    expect(ok.result.isError).toBeFalsy();
    expect(calls[0]).toBe("http://localhost:3100/api/issues/issue-9/interactions");
    const placeholder = await reg.invoke("paperclip_api", JSON.stringify({ method: "GET", path: "/api/issues/{issueId}" }), runtime());
    expect(placeholder.result.isError).toBe(true);
    expect(placeholder.result.content).toContain("unresolved placeholder");
    expect(placeholder.result.content).toContain("heartbeat facts");
    expect(calls).toHaveLength(1);
    const escaped = await reg.invoke("paperclip_api", JSON.stringify({ method: "GET", path: "/api/../../x" }), runtime());
    expect(escaped.result.isError).toBe(true);
    expect(calls).toHaveLength(1);
  });
});

describe("finish_run dispositions", () => {
  it("accepts every issue status the protocol allows", async () => {
    expect(RUN_DISPOSITIONS).toEqual(expect.arrayContaining(["done", "in_review", "blocked", "in_progress", "todo", "backlog", "cancelled", "no_action", "failed"]));
    const reg = new ToolRegistry({ strict: false });
    reg.register(createFinishRunTool());
    const cancelled = await reg.invoke("finish_run", JSON.stringify({ disposition: "cancelled", summary: "Duplicate of PAP-3; cancelled." }), runtime());
    expect(cancelled.validationFailed).toBe(false);
    expect(cancelled.result.finishRun?.disposition).toBe("cancelled");
    const bogus = await reg.invoke("finish_run", JSON.stringify({ disposition: "yolo", summary: "x" }), runtime());
    expect(bogus.validationFailed).toBe(true);
  });
});

describe("connection tools", () => {
  it("time out stalled runtime-tool requests instead of blocking the loop", async () => {
    const fetchImpl = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
    );
    const access: RuntimeToolAccess = {
      version: 1,
      guidance: "",
      mcpEndpoint: "http://localhost:3100/mcp/runtime-tools",
      rest: { connectionsSearch: "http://localhost:3100/api/runtime-tools/connections/search", connectionRequest: "http://localhost:3100/api/runtime-tools/connections/request" },
      bearerToken: "runtime-token",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      tools: ["connections_search", "connection_request"],
    };
    const reg = registryWith(createConnectionTools(access, fetchImpl as unknown as typeof fetch, 50));
    const started = Date.now();
    const result = await reg.invoke("connections_search", JSON.stringify({ query: "github" }), runtime());
    expect(result.result.isError).toBe(true);
    expect(result.result.content).toContain("timed out");
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("skill hardening", () => {
  it("blocks symlinks that leave the skill folder and hides symlinks from the file list", async () => {
    const skillsDir = path.join(tmp, "skills-symlink");
    await fs.mkdir(path.join(skillsDir, "linky"), { recursive: true });
    await fs.writeFile(path.join(skillsDir, "linky", "SKILL.md"), "---\nname: linky\ndescription: Linky\n---\nHi");
    await fs.symlink(path.join(tmp, "src"), path.join(skillsDir, "linky", "outside"));
    await fs.symlink(path.join(tmp, "README.md"), path.join(skillsDir, "linky", "readme-link.md"));
    const catalog = await buildSkillCatalog({ config: {}, moduleDir: tmp, extraSkillsDir: skillsDir, includeBundled: false });
    const reg = new ToolRegistry({ strict: false });
    reg.register(createLoadSkillTool(catalog, 10_000));
    const viaDir = await reg.invoke("load_skill", JSON.stringify({ name: "linky", file: "outside/a.ts" }), runtime());
    expect(viaDir.result.isError).toBe(true);
    expect(viaDir.result.content).toContain("inside the skill folder");
    const viaFile = await reg.invoke("load_skill", JSON.stringify({ name: "linky", file: "readme-link.md" }), runtime());
    expect(viaFile.result.isError).toBe(true);
    const ok = JSON.parse((await reg.invoke("load_skill", JSON.stringify({ name: "linky" }), runtime())).result.content);
    expect(ok.content).toContain("\nHi");
    expect(ok.files).toEqual(["SKILL.md"]);
  });

  it("exposes only the desired Paperclip-managed skills at run time while the snapshot reports missing ones", async () => {
    const managedRoot = path.join(tmp, "managed-skills");
    for (const name of ["paperclip", "deploy", "review"]) {
      await fs.mkdir(path.join(managedRoot, name), { recursive: true });
      await fs.writeFile(path.join(managedRoot, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} skill\n---\n# ${name}`);
    }
    const config = {
      paperclipRuntimeSkills: [
        { key: "paperclipai/paperclip/paperclip", runtimeName: "paperclip", source: path.join(managedRoot, "paperclip") },
        { key: "acme/deploy", runtimeName: "deploy", source: path.join(managedRoot, "deploy") },
        { key: "acme/review", runtimeName: "review", source: path.join(managedRoot, "review") },
        { key: "acme/gone", runtimeName: "gone", source: path.join(managedRoot, "gone"), sourceStatus: "missing" },
      ],
      paperclipSkillSync: { desiredSkills: ["acme/deploy", "acme/gone", "acme/absent"] },
    };
    const runtimeCatalog = await buildSkillCatalog({ config, moduleDir: tmp, includeBundled: false, desiredOnly: true });
    expect(runtimeCatalog.map((entry) => entry.key).sort()).toEqual(["acme/deploy", "paperclipai/paperclip/paperclip"]);
    const fullCatalog = await buildSkillCatalog({ config, moduleDir: tmp, includeBundled: false });
    expect(fullCatalog.map((entry) => entry.key).sort()).toEqual(["acme/deploy", "acme/review", "paperclipai/paperclip/paperclip"]);
    // No explicit preference: only the operational skill is exposed.
    const implicit = await buildSkillCatalog({ config: { paperclipRuntimeSkills: config.paperclipRuntimeSkills }, moduleDir: tmp, includeBundled: false, desiredOnly: true });
    expect(implicit.map((entry) => entry.key)).toEqual(["paperclipai/paperclip/paperclip"]);

    const snapshot = await listSkills({ agentId: "a", companyId: "c", adapterType: "deepseek_api", config });
    expect(snapshot.mode).toBe("ephemeral");
    const byKey = new Map(snapshot.entries.map((entry) => [entry.key, entry]));
    expect(byKey.get("acme/deploy")).toMatchObject({ desired: true, state: "configured" });
    expect(byKey.get("acme/review")).toMatchObject({ desired: false, state: "available" });
    expect(byKey.get("acme/gone")).toMatchObject({ desired: true, state: "missing" });
    expect(byKey.get("acme/absent")).toMatchObject({ desired: true, state: "missing" });
    expect(snapshot.warnings.some((warning) => warning.includes("acme/absent"))).toBe(true);
    expect(byKey.has("paperclip")).toBe(false);
  });
});

describe("prompt guidance", () => {
  it("names the scratch directory in the heartbeat facts and explains placeholders and $VARIABLES", () => {
    const facts = renderHeartbeatFacts({
      runId: "run-1",
      startedAt: "2026-01-01T00:00:00.000Z",
      agentId: "agent-1",
      taskId: "issue-9",
      wakeReason: "assignment",
      wakeCommentId: null,
      approvalId: null,
      approvalStatus: null,
      linkedIssueIds: [],
      resumedSession: false,
      sessionRuns: 0,
      shellEnvKeys: ["PAPERCLIP_RUN_SCRATCH_DIR"],
      scratchDir: "/tmp/paperclip-deepseek/run-1",
    });
    expect(facts).toContain("scratch directory for temporary files (deleted after the run): /tmp/paperclip-deepseek/run-1");
    const prompt = buildSystemPrompt({
      agent: { id: "agent-1", name: "Dee", companyId: "co-1" },
      instructions: null,
      cwd: "/work",
      workspace: { source: null, branch: null, repoUrl: null, worktreePath: null },
      tools: [],
      skills: [],
      paperclipApiUrl: "http://localhost:3100",
      paperclipApiAvailable: true,
      runtimeToolsGuidance: null,
      model: "deepseek-v4-flash",
      reasoningEffort: "high",
    });
    expect(prompt).toContain("$PAPERCLIP_TASK_ID` stand for real ids");
    expect(prompt).toContain("absolute path in the heartbeat facts");
    expect(prompt).not.toContain("Temporary files belong in $PAPERCLIP_RUN_SCRATCH_DIR (removed");
  });

  it("carries the skill rules the protocol previously omitted and the finish_run contract", () => {
    const prompt = buildSystemPrompt({
      agent: { id: "agent-1", name: "Dee", companyId: "co-1" },
      instructions: null,
      cwd: "/work",
      workspace: { source: null, branch: null, repoUrl: null, worktreePath: null },
      tools: [],
      skills: [{ key: "paperclip", name: "paperclip", description: "Paperclip API", sourceDir: "/skills/paperclip", origin: "bundled" }],
      paperclipApiUrl: "http://localhost:3100",
      paperclipApiAvailable: true,
      runtimeToolsGuidance: null,
      model: "deepseek-v4-flash",
      reasoningEffort: "high",
    });
    // Server-verified external chat turns replace the checkout/comment/status steps.
    expect(prompt).toContain('"External chat response contract" section');
    expect(prompt).toContain("make no paperclip_api calls");
    // Pick-work special cases, review wakes, monitors, artifacts, delegation, links.
    expect(prompt).toContain("Blocked-task dedup");
    expect(prompt).toContain("issue_comment_mentioned");
    expect(prompt).toContain("dependency-blocked interaction: yes");
    expect(prompt).toContain("currentParticipant is you");
    expect(prompt).toContain('"Changes requested: ..."');
    expect(prompt).toContain("Do not PATCH status to in_progress to claim work");
    expect(prompt).not.toContain("Never PATCH status to in_progress manually");
    expect(prompt).toContain("non-null monitorNextCheckAt");
    expect(prompt).toContain("invalid_issue_disposition");
    expect(prompt).toContain("paperclip-upload-artifact.sh");
    expect(prompt).toContain("blockedByIssueIds on your issue");
    expect(prompt).toContain("inheritExecutionWorkspaceFromIssueId");
    expect(prompt).toContain("[@Name](agent://<agent-id>)");
    expect(prompt).toContain("documents/plan");
    // The bundled skill's shell workflow is bridged to paperclip_api.
    expect(prompt).toContain("scripts/paperclip-issue-update.sh, use the `paperclip_api` tool instead");
    // Finishing: board-visible summary, in_progress re-wake.
    expect(prompt).toContain("write it as a declarative status");
    expect(prompt).toContain('Paperclip posts "needs a disposition" on the issue and re-wakes you immediately');
    const finish = createFinishRunTool();
    expect(finish.description).toContain("needs a disposition");
    expect(finish.description).toContain("External chat response contract");
    expect(String((finish.parameters.properties as Record<string, { description?: string }>).summary!.description)).toContain("user-visible reply");
  });
});
