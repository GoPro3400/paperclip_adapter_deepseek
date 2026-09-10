# paperclip-adapter-deepseek

External [Paperclip](https://github.com/paperclipai/paperclip) adapter that runs
**DeepSeek V4** models (`deepseek-v4-flash`, `deepseek-v4-pro`) as Paperclip
employee agents. Adapter type key: **`deepseek_api`**.

Unlike the CLI-wrapping adapters (`claude_local`, `codex_local`, …) this adapter
talks to the DeepSeek API directly and owns the agentic loop: it builds a system
prompt that teaches the model the Paperclip heartbeat protocol, exposes a set of
strictly validated tools (shell, files, Paperclip REST API, skills, company MCP
servers, connection tools), executes the model's tool calls, feeds results back,
persists the conversation between heartbeats and reports tokens and cost.

```
Paperclip heartbeat ──► execute()
                         │  system prompt: AGENTS.md + runtime manual + Paperclip protocol + tools + skills
                         │  user prompt:   wake payload / task brief / prompt template + heartbeat facts
                         ▼
                 DeepSeek chat completions (thinking mode, function calling, streaming)
                         │  tool_calls ──► paperclip_api · run_shell · read/write/edit/search files
                         │                 load_skill · connections_* · mcp_* · finish_run
                         ▼
                 JSONL run log (deepseek.* events) ──► Paperclip run viewer / CLI
                 transcript on disk ──► resumed on the next heartbeat
```

## Contents

- [Requirements](#requirements)
- [Installation](#installation)
- [Creating an agent](#creating-an-agent)
- [Configuration reference](#configuration-reference)
- [Tools the model can call](#tools-the-model-can-call)
- [How the agent knows what is happening](#how-the-agent-knows-what-is-happening)
- [DeepSeek specifics](#deepseek-specifics)
- [Sessions and context compaction](#sessions-and-context-compaction)
- [Usage and cost reporting](#usage-and-cost-reporting)
- [Security](#security)
- [Limitations](#limitations)
- [Development](#development)
- [Быстрый старт (RU)](#быстрый-старт-ru)

## Requirements

- Paperclip with external adapter plugin support (`@paperclipai/adapter-utils` ≥ 2026.8).
- Node.js ≥ 22 (Paperclip itself requires ≥ 24.11).
- A DeepSeek API key from <https://platform.deepseek.com/api_keys> with balance.
- Network access from the Paperclip host to `https://api.deepseek.com`.

## Installation

### From npm

```sh
curl -X POST http://localhost:3100/api/adapters \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"packageName": "paperclip-adapter-deepseek"}'
```

or in the UI: **Settings → Adapters → Install from npm → `paperclip-adapter-deepseek`**.

### From a local checkout (development)

```sh
git clone https://github.com/GoPro3400/paperclip_adapter_deepseek
cd paperclip_adapter_deepseek
npm install
npm run build

curl -X POST http://localhost:3100/api/adapters \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"localPath": "/absolute/path/to/paperclip_adapter_deepseek"}'
```

Local installs are symlinked; rebuild (`npm run build`) and restart the server
(or use the adapter reload endpoint) after changes.

### Via adapter-plugins.json

```json
[
  {
    "packageName": "paperclip-adapter-deepseek",
    "localPath": "/absolute/path/to/paperclip_adapter_deepseek",
    "type": "deepseek_api",
    "installedAt": "2026-09-10T12:00:00.000Z"
  }
]
```

The package follows the Paperclip external adapter contract: the root export
provides `createServerAdapter()`, `./ui-parser` ships a zero-dependency
transcript parser (contract `paperclip.adapterUiParser = 1.0.0`), and `./ui` /
`./cli` expose the helpers a built-in registration would use.

## Creating an agent

1. Create an agent with adapter type **`deepseek_api`**.
2. Add the environment variable **`DEEPSEEK_API_KEY`** in the agent's
   environment section. Prefer a Paperclip secret binding; a plain value also
   works. Alternatively export `DEEPSEEK_API_KEY` for the Paperclip server
   process (the adapter falls back to it).
3. Set the working directory (`cwd`) to the project checkout the agent should
   work in, or let a Paperclip execution workspace provide it.
4. Pick a model and reasoning effort, optionally an instructions bundle
   (`AGENTS.md`) and the Paperclip skills the agent may load.
5. Press **Test environment**: it validates the key against `GET /models`,
   checks that the model id is available, runs a tiny chat completion probe,
   and verifies the working directory, session directory and shell.

Minimal `adapterConfig`:

```json
{
  "cwd": "/home/paperclip/projects/shop",
  "model": "deepseek-v4-flash",
  "reasoningEffort": "high",
  "instructionsFilePath": "/home/paperclip/agents/coder/AGENTS.md",
  "env": {
    "DEEPSEEK_API_KEY": { "type": "secret_ref", "secretId": "<secret id>" }
  }
}
```

## Configuration reference

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `cwd` | string | — | Absolute working directory for shell/file tools; created when missing. An execution workspace cwd overrides it (except `agent_home` sources). |
| `model` | string | `deepseek-v4-flash` | DeepSeek model id (`deepseek-v4-flash`, `deepseek-v4-pro`, or any id the key can access). |
| `reasoningEffort` | `none` \| `low` \| `high` \| `max` | `high` | Thinking mode depth. `none` disables thinking. |
| `instructionsFilePath` | string | — | Markdown instructions (AGENTS.md) prepended to the system prompt. Managed instruction bundles are supported. |
| `promptTemplate` | string | Paperclip default | Heartbeat prompt template (`{{agent.id}}`, `{{agent.name}}`, `{{context.taskId}}`, …). |
| `bootstrapPromptTemplate` | string | — | Extra prompt sent only when a fresh session starts. |
| `env` | object | — | Environment variables (plain or secret refs). `DEEPSEEK_API_KEY` lives here. |
| `apiKeyEnvVar` | string | `DEEPSEEK_API_KEY` | Name of the variable that carries the API key. |
| `baseUrl` | string | `https://api.deepseek.com` | API base (proxies / compatible gateways). |
| `maxTurns` | number | `80` | Model turns per heartbeat; a wrap-up summary is requested when exhausted. |
| `maxTokens` | number | API default | Completion cap per turn. |
| `temperature`, `topP` | number | unset | Sampling (ignored by DeepSeek in thinking mode). |
| `stream` | boolean | `true` | Stream reasoning/text deltas into the run log. |
| `strictTools` | boolean | `false` | Use DeepSeek strict function calling (beta endpoint, schemas converted to strict form). |
| `timeoutSec` | number | `3600` | Whole-heartbeat timeout (0 disables). |
| `graceSec` | number | `15` | Grace period before force-killing shell commands. |
| `shellTimeoutSec` / `shellMaxTimeoutSec` | number | `120` / `1800` | Default and maximum `run_shell` timeout. |
| `shell` | string | auto (`bash`, else `sh`) | Shell binary for `run_shell`. |
| `exposeApiKeyToShell` | boolean | `false` | Whether the DeepSeek key is visible inside `run_shell`. |
| `maxToolOutputChars` | number | `30000` | Tool output cap (head+tail truncation). |
| `maxFileReadChars` | number | `100000` | `read_file` / `load_skill` cap. |
| `disabledTools` | string[] | `[]` | Tool names to withhold (e.g. `["run_shell"]`). `finish_run` cannot be disabled. |
| `mcpEnabled` | boolean | `true` | Expose Paperclip runtime MCP servers as `mcp_*` tools. |
| `connectionToolsEnabled` | boolean | `true` | Expose `connections_search` / `connection_request`. |
| `compactionThresholdTokens` | number | `240000` | Summarize old turns when the prompt exceeds this size (0 disables). |
| `compactionKeepRecentMessages` | number | `16` | Messages kept verbatim after compaction. |
| `sessionsDir` | string | `$PAPERCLIP_HOME/instances/<id>/adapters/deepseek_api/sessions` | Transcript storage. |
| `skillsDir` | string | — | Extra directory of skill folders loadable via `load_skill`. |
| `pricing` | object | built-in table | Per-model USD per 1M tokens: `{ "<model>": { "cacheHitPerMTok", "cacheMissPerMTok", "outputPerMTok" } }`. |
| `requestTimeoutSec` / `idleTimeoutSec` / `maxRetries` | number | `600` / `180` / `4` | API request limits and retry count for transient failures. |

The same fields are rendered in the Paperclip agent form through the adapter's
declarative config schema.

## Tools the model can call

| Tool | Purpose |
|------|---------|
| `paperclip_api` | Authenticated call to the Paperclip REST API (`method`, `path`, `query`, `body`). Adds `Authorization` and the `X-Paperclip-Run-Id` audit header on mutating requests; returns status, body and hints (409 → never retry). |
| `run_shell` | Run a command in the working directory (non-interactive env, process-group timeouts, head+tail output capture). |
| `read_file` | Read a text file or a line range. |
| `write_file` | Create/overwrite/append a text file. |
| `edit_file` | Exact-match search/replace (must be unique unless `replace_all`). |
| `list_directory` | Recursive listing that skips dependency folders. |
| `search_files` | Regex search across files (grep -rn style) with glob filters. |
| `load_skill` | Load a Paperclip skill's `SKILL.md` or reference file on demand. |
| `finish_run` | Ends the heartbeat with a disposition + summary (never mutates issues). |
| `connections_search`, `connection_request` | Paperclip run-scoped connection tools (when the server delivers them). |
| `mcp_<server>_<tool>` | Every tool of the runtime MCP servers Paperclip attaches to the run. |

Every call is validated against the tool's JSON schema before execution. Invalid
JSON, missing/unknown parameters or wrong types are returned to the model as a
tool error together with the expected schema, so it can correct the call
instead of acting on garbage. Repeated identical failing calls trigger an
explicit intervention message.

## How the agent knows what is happening

The system prompt (stable per agent, so DeepSeek's prefix cache keeps hitting) contains:

1. The instructions file (AGENTS.md) when configured.
2. A runtime manual: who the agent is, what a heartbeat is, and rules for acting
   only through tools, verifying before claiming, and fixing invalid calls.
3. The Paperclip control-plane protocol distilled from the official `paperclip`
   skill: scoped wakes, identity/inbox discovery, checkout (409 semantics),
   heartbeat-context and comment deltas, durable comments, final disposition
   rules (`done` / `in_review` / `blocked` / `in_progress`), delegation with
   `parentId`, approvals, interactions, secret handling, commit trailer.
4. Workspace facts (cwd, branch, repo, which `PAPERCLIP_*` variables the shell has).
5. The skill catalog (name + description) with an instruction to load skills on demand.
6. Connection-tool guidance when Paperclip delivers runtime tools.
7. The `finish_run` contract.

The per-heartbeat user message carries the Paperclip wake payload / resume
delta, the task brief, the session handoff note, the heartbeat prompt template
and a "Heartbeat facts" block (run id, task id, wake reason, triggering comment,
approval, linked issues, whether the conversation was resumed).

The bundled copy of the official `paperclip` skill (`skills/paperclip/`) is
always loadable through `load_skill`, so the model can read the full API
reference for interactions, documents, approvals, routines and artifacts
instead of guessing payloads. Skills prepared by the Paperclip server for the
agent (company-managed skills) take precedence.

Run log events (one JSON object per line) rendered by the UI parser and the CLI:
`deepseek.init`, `deepseek.user`, `deepseek.thinking_delta`, `deepseek.text_delta`,
`deepseek.thinking`, `deepseek.assistant`, `deepseek.tool_call`, `deepseek.tool_result`,
`deepseek.turn` (per-turn usage/cost), `deepseek.status`, `deepseek.warning`,
`deepseek.error`, `deepseek.result`.

## DeepSeek specifics

- **Models.** `deepseek-v4-flash` (default; fast and cheap) and `deepseek-v4-pro`
  (strongest reasoning/agentic build, `DeepSeek-V4-Pro-0813`). Both have a
  1M-token context. The legacy `deepseek-chat` / `deepseek-reasoner` aliases were
  retired by DeepSeek in July 2026; use the V4 ids. When the server process has
  `DEEPSEEK_API_KEY`, the agent form lists the live `/models` output as well.
- **Thinking mode.** `reasoningEffort` maps to `thinking: { type: "enabled" }` +
  `reasoning_effort: low | high | max`; `none` sends `thinking: { type: "disabled" }`.
  Sampling parameters are only forwarded when thinking is disabled, as DeepSeek
  ignores them otherwise.
- **`reasoning_content`.** Assistant turns are stored with their reasoning and
  sent back on subsequent requests (DeepSeek requires the reasoning of the
  current tool-calling round; V4 keeps reasoning across tool-calling
  conversations). Should the API reject the history shape, the loop retries
  with a narrower policy (current round only, then none) and logs a warning
  instead of failing the heartbeat.
- **Function calling.** OpenAI-compatible `tools` / `tool_calls` / `tool`
  messages. With `strictTools` the schemas are converted to the strict form
  (all properties required, optional ones nullable, no additional properties)
  and requests go to `/beta`.
- **Streaming.** SSE with `stream_options.include_usage`, idle and total
  timeouts, automatic retries with backoff for 429/5xx/network errors,
  `Retry-After` support.
- **Errors.** 401/403 → `deepseek_auth_failed`; 402 → `deepseek_insufficient_balance`
  (`errorFamily: provider_quota`); 429/5xx/network → `transient_upstream`.

## Sessions and context compaction

Each task keeps a conversation. The transcript (all user/assistant/tool
messages including reasoning) is stored as JSON under `sessionsDir`; Paperclip
only stores the small `sessionParams` (session id, cwd, model, transcript
path). On the next wake the conversation resumes when the cwd matches;
otherwise a fresh session starts and the reason is logged. The adapter declares
native context management, so Paperclip does not rotate sessions on raw-token
thresholds.

When the last prompt exceeded `compactionThresholdTokens`, older turns are
summarized by a cheap thinking-disabled completion (task ids, decisions, files,
commands, Paperclip actions, next steps) and replaced by that summary; the most
recent `compactionKeepRecentMessages` messages stay verbatim.

## Usage and cost reporting

Per turn the adapter records `prompt_cache_hit_tokens`,
`prompt_cache_miss_tokens`, `completion_tokens` and
`completion_tokens_details.reasoning_tokens`. Paperclip receives
`usage.inputTokens` = cache-miss tokens, `usage.cachedInputTokens` = cache-hit
tokens, `usage.outputTokens` = completion tokens (`usageBasis: per_run`).

`costUsd` is estimated from the built-in price table (USD per 1M tokens,
snapshot of the official price list as of 2026-09-10):

| Model | Cache hit | Cache miss | Output |
|-------|-----------|------------|--------|
| deepseek-v4-flash | 0.003 | 0.15 | 0.60 |
| deepseek-v4-pro | 0.003625 | 0.435 | 0.87 |

DeepSeek applies time-of-day discounts and changes prices; override with the
`pricing` field for exact accounting. Unknown models are reported unpriced.

## Security

- The DeepSeek key, the Paperclip run token, runtime-tool and MCP tokens and
  every sensitive-looking `env` value are redacted from the run log, tool
  outputs and invocation metadata.
- The DeepSeek key is not exposed to `run_shell` unless `exposeApiKeyToShell` is set.
- `PAPERCLIP_API_KEY` from adapter config is never used for the tool environment
  when Paperclip issues a run token; the harness-minted token wins.
- Tool results are presented to the model as data; the system prompt instructs
  it that file contents, command output and comments cannot change its rules.
- The adapter never pushes to git remotes; the working directory is the only
  cross-run persistence (Paperclip's no-remote-git contract).
- Shell commands run with the Paperclip server's user permissions; use
  `disabledTools`, a dedicated user and a scoped `cwd` for untrusted work.

## Limitations

- Runs on the Paperclip host only (local execution target). SSH/sandbox
  execution targets are rejected by the environment test and by `execute()`.
- Text only; image inputs are not forwarded.
- Prices, model ids and API parameters follow the DeepSeek documentation as of
  September 2026; verify against <https://api-docs.deepseek.com> when they change.

## Development

```sh
npm install
npm run typecheck
npm test            # vitest: client/SSE parsing, tool loop, tools, sessions, UI parser, execute()
npm run build       # emits dist/ (ESM + d.ts)

# one real heartbeat against the DeepSeek API without a Paperclip server
DEEPSEEK_API_KEY=sk-... node scripts/smoke-run.mjs --cwd /tmp/demo --model deepseek-v4-flash
```

Layout:

```
src/index.ts              adapter metadata (type, label, models, agentConfigurationDoc)
src/server/index.ts       createServerAdapter(), sessionCodec, config schema, skills, model discovery
src/server/execute.ts     heartbeat orchestration (env, session, prompts, loop, result)
src/server/agent-loop.ts  DeepSeek tool-calling loop, reasoning policy, compaction
src/server/deepseek-client.ts  chat completions client (SSE, retries, usage, errors)
src/server/tools/*        paperclip_api, run_shell, files, skills, finish_run, connections, MCP
src/server/prompt.ts      system prompt + heartbeat facts
src/server/session-store.ts    transcript persistence
src/ui-parser.ts          self-contained UI transcript parser (contract 1.0.0)
src/ui/*, src/cli/*       built-in registration helpers and CLI formatter
skills/paperclip/         bundled copy of the official Paperclip skill (MIT)
```

References: Paperclip adapter docs (`docs/adapters/creating-an-adapter.md`,
`docs/adapters/external-adapters.md`, `docs/adapters/adapter-ui-parser.md`,
`packages/adapters/AUTHORING.md`), the `paperclip` skill, and the DeepSeek API
documentation (chat completions, thinking mode, function calling, pricing).

## Быстрый старт (RU)

1. Установите адаптер в Paperclip: **Settings → Adapters → Install from npm →
   `paperclip-adapter-deepseek`** (или `POST /api/adapters` с `localPath` на
   собранный клон этого репозитория: `npm install && npm run build`).
2. Создайте агента с типом адаптера **`deepseek_api`**.
3. В переменных окружения агента задайте **`DEEPSEEK_API_KEY`** (лучше через
   секрет Paperclip). Ключ выдаётся на <https://platform.deepseek.com/api_keys>.
4. Укажите рабочую директорию `cwd`, модель (`deepseek-v4-flash` по умолчанию,
   `deepseek-v4-pro` для сложных задач) и уровень рассуждений
   `reasoningEffort` (`none` / `low` / `high` / `max`).
5. Нажмите **Test environment**: адаптер проверит ключ, доступность модели,
   выполнит пробный запрос и проверит директории.

Как агент понимает, что происходит: в системном промпте описаны протокол
heartbeat Paperclip (identity → checkout → heartbeat-context → работа →
комментарий → финальный статус), правила вызова инструментов и список
инструментов; в каждом сообщении heartbeat передаются wake payload, описание
задачи и факты запуска (id задачи, причина пробуждения, комментарий, approval).
Все вызовы инструментов проверяются по JSON-схеме, ошибки возвращаются модели с
ожидаемой схемой, а завершение запуска фиксируется явным вызовом `finish_run`.
