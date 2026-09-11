# paperclip-adapter-deepseek

External [Paperclip](https://github.com/paperclipai/paperclip) adapter that runs
**DeepSeek** models (`deepseek-flash`, `deepseek-v4-pro`) as Paperclip
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
                 JSONL run log (deepseek.* events) ──► Paperclip run viewer (UI parser)
                 transcript on disk ──► resumed on the next heartbeat
```

## Contents

- [Requirements](#requirements)
- [Installation](#installation)
- [Installing into a dockerized Paperclip](docs/install-docker.md)
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
- Node.js ≥ 24.11 (same as Paperclip and `@paperclipai/adapter-utils`).
- A DeepSeek API key from <https://platform.deepseek.com/api_keys> with balance.
- Network access from the Paperclip host to `https://api.deepseek.com`. Behind a
  proxy, start the Paperclip server with `NODE_USE_ENV_PROXY=1`: Node's `fetch`
  ignores `HTTPS_PROXY` otherwise and the adapter's requests bypass the proxy.

## Installation

Adapter installs require instance-admin access. The simplest route is the UI:
**Settings → Adapters → Install**. The API route behind that button is
`POST /api/adapters/install`, shown below for scripting.

Running Paperclip in Docker? Paths are resolved inside the container, so read
**[docs/install-docker.md](docs/install-docker.md)** — it has a verified,
container-specific walkthrough.

### From npm

```sh
curl -X POST http://localhost:3100/api/adapters/install \
  -H "Content-Type: application/json" \
  -d '{"packageName": "paperclip-adapter-deepseek"}'
```

The server runs `npm install --no-save` into its managed plugin directory
(`$PAPERCLIP_HOME/adapter-plugins`), so the Paperclip host needs access to the
registry. Update later with `POST /api/adapters/deepseek_api/reinstall`.

### From a local checkout

```sh
git clone https://github.com/GoPro3400/paperclip_adapter_deepseek
cd paperclip_adapter_deepseek
npm install
npm run build

curl -X POST http://localhost:3100/api/adapters/install \
  -H "Content-Type: application/json" \
  -d '{"packageName": "/absolute/path/to/paperclip_adapter_deepseek", "isLocalPath": true}'
```

A local install is loaded from that path on every server start — the directory is
read in place, not copied or symlinked, so it must stay where it is and keep its
`node_modules` (the built `dist/` imports `@paperclipai/adapter-utils` at runtime).
After a rebuild, pick up the new code with `POST /api/adapters/deepseek_api/reload`
or a server restart; `reinstall` is for npm-sourced adapters only.

### Via adapter-plugins.json

Paperclip records the installation in `$PAPERCLIP_HOME/adapter-plugins.json` and
replays it at startup. Writing the record by hand and restarting works too:

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

Confirm any of the three with `GET /api/adapters`: the entry must report
`"source": "external"` and `"loaded": true`.

The package follows the Paperclip external adapter contract: the root export
provides `createServerAdapter()`, `./ui-parser` ships a zero-dependency
transcript parser (contract `paperclip.adapterUiParser = 1.0.0`), and `./ui` /
`./cli` expose the helpers a built-in registration would use. The Paperclip CLI
only loads its built-in adapter formatters, so for an externally installed
plugin `paperclipai run --watch` prints the raw `deepseek.*` JSONL lines
(plus the human-readable `[paperclip] ...` status lines); the `./cli` formatter
applies only if the adapter is registered in the CLI's built-in registry.

## Creating an agent

1. Create an agent with adapter type **`deepseek_api`**.
2. Add the environment variable **`DEEPSEEK_API_KEY`** in the agent's
   environment section. Prefer a Paperclip secret binding; a plain value also
   works. Alternatively export `DEEPSEEK_API_KEY` for the Paperclip server
   process (the adapter falls back to it).
3. Set the working directory (`cwd`) to the project checkout the agent should
   work in, or let a Paperclip execution workspace provide it.
4. Pick a model in the form's model dropdown (live `/models` output when the
   server has a key) and a thinking effort; the adapter's own **DeepSeek
   reasoning effort** field overrides it when you need `none` or `max`.
   Optionally add an instructions bundle (`AGENTS.md`) and the Paperclip skills
   the agent may load.
5. Press **Test environment**: it validates the key against `GET /models`,
   checks that the model id is available, runs a tiny chat completion probe,
   and verifies the working directory, session directory and shell.

Minimal `adapterConfig`:

```json
{
  "cwd": "/home/paperclip/projects/shop",
  "model": "deepseek-flash",
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
| `model` | string | `deepseek-flash` | DeepSeek model id (`deepseek-flash`, `deepseek-v4-pro`, or any id the key can access). Set from the form's model dropdown. |
| `reasoningEffort` | `none` \| `low` \| `high` \| `max` | `high` | Thinking mode depth. `none` disables thinking. When unset, the form's Thinking effort control (`thinkingEffort` / `effort`) applies; `medium` counts as `high`, `off` as `none`, `xhigh` as `max`. |
| `instructionsFilePath` | string | — | Markdown instructions (AGENTS.md) prepended to the system prompt. Managed instruction bundles are supported. |
| `promptTemplate` | string | Paperclip default | Heartbeat prompt template (`{{agent.id}}`, `{{agent.name}}`, `{{context.taskId}}`, …). |
| `bootstrapPromptTemplate` | string | — | Extra prompt sent only when a fresh session starts. |
| `env` | object | — | Environment variables (plain or secret refs). `DEEPSEEK_API_KEY` lives here. |
| `apiKeyEnvVar` | string | `DEEPSEEK_API_KEY` | Name of the variable that carries the API key. |
| `baseUrl` | string | `https://api.deepseek.com` | API base (proxies / compatible gateways). |
| `maxTurns` | number | `80` | Model turns per heartbeat. When exhausted a wrap-up summary is requested and the run fails with `max_turns_exhausted` (session kept) so Paperclip's max-turn continuation resumes the transcript. |
| `maxTokens` | number | API default | Completion cap per turn. |
| `temperature`, `topP` | number | unset | Sampling (ignored by DeepSeek in thinking mode). |
| `stream` | boolean | `true` | Stream reasoning/text deltas into the run log. |
| `strictTools` | boolean | `false` | Use DeepSeek strict function calling (beta endpoint, schemas converted to strict form; see below). A 400 in strict mode carries a hint to turn it off. |
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
| `sessionMaxAgeDays` | number | `0` (off) | Housekeeping: transcripts not written for this many days are deleted after each run. |
| `skillsDir` | string | — | Extra directory of skill folders loadable via `load_skill`. |
| `pricing` | object | built-in table | Per-model USD per 1M tokens: `{ "<model>": { "cacheHitPerMTok", "cacheMissPerMTok", "outputPerMTok" } }`. |
| `requestTimeoutSec` / `idleTimeoutSec` / `maxRetries` | number | `600` / `180` / `4` | Total request limit (not retried; raise it for long thinking budgets), streaming idle limit (non-streaming calls are bounded by the total limit only) and retry count for transient failures. |

The Paperclip agent form renders its own model dropdown and Thinking effort
control for this adapter; the remaining fields come from the adapter's
declarative config schema (which therefore declares no `model` field and no
`reasoningEffort` default, so the operator's choices are not overwritten on
create).

## Tools the model can call

| Tool | Purpose |
|------|---------|
| `paperclip_api` | Authenticated call to the Paperclip REST API (`method`, `path`, `query`, `body`). Adds `Authorization` and the `X-Paperclip-Run-Id` audit header on mutating requests; returns status, body and hints (409 → never retry). `$PAPERCLIP_TASK_ID`, `$PAPERCLIP_AGENT_ID` and `$PAPERCLIP_COMPANY_ID` in paths are filled in; other placeholders (`{issueId}`) and paths escaping `/api/` are rejected before any request. |
| `run_shell` | Run a command in the working directory (non-interactive env, process-group timeouts, head+tail output capture that keeps the real beginning and end of very large output). The call returns when the shell exits; detached helpers must redirect their output (`cmd > log 2>&1 < /dev/null &`), and the whole process group is terminated when the timeout fires. |
| `read_file` | Read a text file or a line range (files over 32 MiB are refused with a hint to page with `sed`/`grep`). |
| `write_file` | Create/overwrite/append a text file. |
| `edit_file` | Exact-match search/replace (must be unique unless `replace_all`). |
| `list_directory` | Recursive listing that skips dependency folders. |
| `search_files` | Regex search across files (grep -rn style) with glob filters (`*`, `**`, `?`, `{ts,tsx}`); nested-quantifier patterns are rejected and the walk honours run cancellation. |
| `load_skill` | Load a Paperclip skill's `SKILL.md` or reference file on demand. |
| `finish_run` | Ends the heartbeat with a disposition (any final issue status, `no_action` or `failed`) + summary (never mutates issues). The summary is reported to Paperclip (up to 20 000 chars) and may be posted as the run's issue comment when the agent left none; in a server-verified external-chat turn it is the user-visible reply. |
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
   skill: the external-chat shortcut (server-verified chat turns make no API
   calls and answer through the `finish_run` summary), scoped wakes,
   identity/inbox discovery, blocked-task dedup and mention-handoff rules,
   checkout (409 semantics), execution-policy review wakes, heartbeat-context
   and comment deltas, durable comments with company-prefixed links and
   structured agent mentions, plans as issue documents, artifacts and work
   products, final disposition rules (`done` / `in_review` / `blocked` /
   `in_progress`) including real monitors, delegation with `parentId` and
   `blockedByIssueIds`, approvals, interactions, secret handling, commit
   trailer.
4. Workspace facts (cwd, branch, repo, the fixed list of `PAPERCLIP_*` variables the
   shell can carry; the ones actually set for the current wake are listed in the
   heartbeat facts so the system prompt never changes between wakes).
5. The skill catalog (name + description) with an instruction to load skills on demand.
6. Connection-tool guidance when Paperclip delivers runtime tools.
7. The `finish_run` contract: one call per heartbeat, the summary written as a
   declarative status (Paperclip may post it as the run's issue comment), and
   the warning that leaving an issue `in_progress` without a live continuation
   path makes Paperclip post "needs a disposition" and re-wake the agent
   immediately.

The per-heartbeat user message carries the Paperclip wake payload / resume
delta, the task brief, the session handoff note, the heartbeat prompt template
and a "Heartbeat facts" block (run id, task id, wake reason, triggering comment,
approval, linked issues, the `PAPERCLIP_*` variables set for `run_shell`, the
absolute per-run scratch directory, whether the conversation was resumed). File
tools expand `~`, `$HOME` and `$PAPERCLIP_*` run variables in paths (nothing else). On newer Paperclip servers that attach an
`executionContinuation` snapshot (current objective, task messages, completed
actions) the adapter renders it as a "Current request and continuation context"
section and includes it in `PAPERCLIP_WAKE_PAYLOAD_JSON`, matching the built-in
adapters, until the published `@paperclipai/adapter-utils` release does so itself.

The bundled copy of the official `paperclip` skill (`skills/paperclip/`) is
always loadable through `load_skill`, so the model can read the full API
reference for interactions, documents, approvals, routines, monitors and
artifacts instead of guessing payloads. The skill is written for shell-based
agents; the system prompt tells the model to use `paperclip_api` wherever the
skill says curl/jq/`scripts/paperclip-issue-update.sh` (that script is not
shipped by Paperclip) and to run the existing skill scripts (such as
`scripts/paperclip-upload-artifact.sh`) by absolute path under the skill
directory returned by `load_skill`. Skills prepared by the Paperclip server for the
agent (company-managed skills) take precedence. At run time only the managed
skills assigned to the agent in the Skills panel (plus the operational
`paperclip` skill) are listed in the prompt and loadable, like the other local
adapters; `skillsDir` and bundled skills are always available. The Skills panel
reports assigned skills whose files Paperclip could not materialize as
`missing`, with a warning.

Run log events (one JSON object per line) rendered by the UI parser (and by the
`./cli` formatter when registered built-in):
`deepseek.init`, `deepseek.user`, `deepseek.thinking_delta`, `deepseek.text_delta`,
`deepseek.thinking`, `deepseek.assistant`, `deepseek.tool_call`, `deepseek.tool_result`,
`deepseek.turn` (per-turn usage/cost), `deepseek.status`, `deepseek.warning`,
`deepseek.error`, `deepseek.result`.

## DeepSeek specifics

- **Models.** `deepseek-flash` (default) serves DeepSeek-V4.1-Flash and is what
  `GET /models` advertises. `deepseek-v4-pro` serves DeepSeek-V4-Pro-0813, but
  DeepSeek routes it to V4.1 Flash from 2026-09-14 04:00 UTC and is retiring it.
  `deepseek-v4-flash` still works as a legacy name for the same Flash weights.
  `deepseek-chat` / `deepseek-reasoner` were retired in July 2026. Both models
  have a 1M-token context and a 384K max output. When the server process has
  `DEEPSEEK_API_KEY`, the agent form lists the live `/models` output as well.
- **Thinking mode.** `reasoningEffort` maps to `thinking: { type: "enabled" }` +
  `reasoning_effort: low | high | max`; `none` sends `thinking: { type: "disabled" }`.
  DeepSeek enables thinking by default at effort `high`. `temperature` has no
  effect while thinking is on, so it is only sent when thinking is off; `top_p`
  is the opposite (it applies in thinking mode with a 0.95 floor) and is sent
  accordingly. Other spellings of the effort are folded to the official set:
  `minimal` to low, `medium` and `xhigh` to high, `ultra` to max.
- **`reasoning_content`.** DeepSeek requires that, when a request carries
  `tools`, the reasoning of **every** previous assistant turn is replayed, and
  returns a 400 otherwise. The adapter stores reasoning on each turn and sends
  it all back. Should a future API version reject the shape, the loop falls back
  to a narrower policy (current round only, then none) with a warning instead of
  failing the heartbeat.
- **Function calling.** OpenAI-compatible `tools` / `tool_calls` / `tool`
  messages. With `strictTools` the schemas are converted to the strict form
  (fixed-shape objects list every property as required, optional ones accept
  null, no additional properties; enum properties accept null too) and
  requests go to `/beta`. Free-form objects such as `paperclip_api` `query` /
  `body` and untyped MCP inputs are left open, and validation-only keywords
  (`minimum`, `minLength`, `pattern`, ...) are stripped from the copy sent to
  the API; arguments are still validated locally against the original schema,
  and the nulls strict mode adds for omitted optional properties are dropped
  (nulls inside free-form bodies are kept).
- **Streaming.** SSE with `stream_options.include_usage`, idle and total
  timeouts, automatic retries with backoff for 429/5xx/network errors and
  stream stalls (never for the total `requestTimeoutSec`, and never when the
  heartbeat deadline is too close), `Retry-After` support. When a retry
  follows partial streamed output a `deepseek.status` line marks the restart
  so the earlier deltas can be discarded. A 200 response carrying an error
  object or no SSE data is treated as a transient provider fault, not as an
  empty reply.
- **Errors.** 401/403 → `deepseek_auth_failed`; 402 → `deepseek_insufficient_balance`
  (`errorFamily: provider_quota`); 429/5xx/network → `transient_upstream`.
- **Run outcomes.** `finish_run` or a final text reply → succeeded. Turn budget
  exhausted → failed with `max_turns_exhausted` (after the wrap-up summary). No
  final response at all (two empty replies, or output cut off by `max_tokens`
  before any text) → failed with `deepseek_empty_response` /
  `deepseek_output_truncated`. A 400 that rejects the stored history on the
  first request of a resumed session → failed with `deepseek_session_rejected`
  and the session is cleared (the transcript is kept as `<id>.json.rejected`).
  All of these keep the session unless stated otherwise.

## Sessions and context compaction

Each task keeps a conversation. The transcript (all user/assistant/tool
messages including reasoning) is stored as JSON under `sessionsDir`; Paperclip
only stores the small `sessionParams` (session id, cwd, model, transcript
path). On the next wake the conversation resumes when the cwd matches;
otherwise a fresh session starts and the reason is logged. When Paperclip
itself moves a session to a new workspace (it rewrites `sessionParams.cwd`),
the transcript is resumed there. Failures before the model is called (missing
API key, invalid cwd, unsupported execution target) do not touch the persisted
session. The adapter declares native context management, so Paperclip does not
rotate sessions on raw-token thresholds.

When the last prompt exceeded `compactionThresholdTokens`, older turns are
summarized by a cheap thinking-disabled completion (task ids, decisions, files,
commands, Paperclip actions, next steps) and replaced by that summary; the most
recent `compactionKeepRecentMessages` messages stay verbatim. The cut lands on a
heartbeat boundary when that keeps at most twice `compactionKeepRecentMessages`
messages, otherwise on a tool-round boundary, so a single long heartbeat is
compacted mid-run as well. Summariser requests are counted in the run's usage
and cost (`resultJson.compactionUsage`). If the summariser fails or returns
nothing, compaction is disabled for the rest of that run with one warning
instead of being retried before every turn.

Transcripts are rewritten in full after each run and are never deleted
automatically unless `sessionMaxAgeDays` is set; otherwise clean `sessionsDir`
manually when agents or tasks are retired.

## Usage and cost reporting

Per turn the adapter records `prompt_cache_hit_tokens`,
`prompt_cache_miss_tokens`, `completion_tokens` and
`completion_tokens_details.reasoning_tokens`. Paperclip receives
`usage.inputTokens` = cache-miss tokens, `usage.cachedInputTokens` = cache-hit
tokens, `usage.outputTokens` = completion tokens (`usageBasis: per_run`).

`costUsd` comes from the official price table (USD per 1M tokens, verified
2026-09-11). DeepSeek charges double during peak hours, so the adapter picks the
tier from the run's start time:

| Model | Cache hit | Cache miss | Output |
|-------|-----------|------------|--------|
| deepseek-flash, off-peak | 0.003 | 0.15 | 0.60 |
| deepseek-flash, peak | 0.006 | 0.30 | 1.20 |
| deepseek-v4-pro, off-peak | 0.022 | 0.66 | 1.98 |
| deepseek-v4-pro, peak | 0.044 | 1.32 | 3.96 |

Peak hours are 01:00-04:00 and 06:00-10:00 UTC, Monday to Friday. From
2026-09-14 04:00 UTC `deepseek-v4-pro` is billed at the Flash price, which the
table above applies automatically. Reasoning tokens bill at the output rate.
Prices change; override them with the `pricing` field (a flat rate that wins
over both tiers) when exact accounting matters. Unknown models are unpriced.

## Security

- The DeepSeek key, the Paperclip run token, runtime-tool and MCP tokens and
  every sensitive-looking `env` value are redacted from the run log, tool
  outputs and invocation metadata.
- `run_shell` inherits the Paperclip server process environment (like the other
  local adapters) minus `PAPERCLIP_*` variables (the run sets its own) and the
  DeepSeek key: the key is not exposed to `run_shell` unless `exposeApiKeyToShell`
  is set, whether it comes from the agent `env` or the server environment.
- `PAPERCLIP_API_KEY` from adapter config is never used: only the harness-minted
  run token authenticates `paperclip_api` and `run_shell`. Without a run token
  the tool is unavailable and a `deepseek.warning` says so in the run log.
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
- Server-verified external-chat turns are answered through the `finish_run`
  summary, but the adapter has no native semantic-result channel, so it cannot
  report `yielded` / `response_wake` to keep a chat task open for the user's
  next message.
- Prices, model ids and API parameters follow the DeepSeek documentation as of
  September 2026; verify against <https://api-docs.deepseek.com> when they change.

## Development

```sh
npm install
npm run typecheck
npm test            # vitest: client/SSE parsing, tool loop, tools, sessions, UI parser, execute()
npm run build       # emits dist/ (ESM + d.ts)

# one real heartbeat against the DeepSeek API without a Paperclip server
DEEPSEEK_API_KEY=sk-... node scripts/smoke-run.mjs --cwd /tmp/demo --model deepseek-flash
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

1. Установите адаптер в Paperclip: **Settings → Adapters → Install** — имя пакета
   `paperclip-adapter-deepseek` или путь к собранному клону этого репозитория
   (`npm install && npm run build`). То же самое через API:
   `POST /api/adapters/install` с телом
   `{"packageName": "...", "isLocalPath": true}` для локального пути.
   Если Paperclip запущен в Docker, см. [docs/install-docker.md](docs/install-docker.md):
   путь резолвится внутри контейнера, каталог адаптера нужно прокинуть томом.
2. Создайте агента с типом адаптера **`deepseek_api`**.
3. В переменных окружения агента задайте **`DEEPSEEK_API_KEY`** (лучше через
   секрет Paperclip). Ключ выдаётся на <https://platform.deepseek.com/api_keys>.
4. Укажите рабочую директорию `cwd`, модель в выпадающем списке формы
   (`deepseek-flash` по умолчанию) и
   уровень рассуждений: Thinking effort формы или поле адаптера
   `reasoningEffort` (`none` / `low` / `high` / `max`), которое имеет приоритет.
5. Нажмите **Test environment**: адаптер проверит ключ, доступность модели,
   выполнит пробный запрос и проверит директории.

Как агент понимает, что происходит: в системном промпте описаны протокол
heartbeat Paperclip (identity → checkout → heartbeat-context → работа →
комментарий → финальный статус), правила вызова инструментов и список
инструментов; в каждом сообщении heartbeat передаются wake payload, описание
задачи и факты запуска (id задачи, причина пробуждения, комментарий, approval).
Все вызовы инструментов проверяются по JSON-схеме, ошибки возвращаются модели с
ожидаемой схемой, а завершение запуска фиксируется явным вызовом `finish_run`.
