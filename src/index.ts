/**
 * Shared adapter metadata. Imported by the server, UI and CLI consumers, so it
 * must stay dependency-free (no Node APIs, no React).
 */
import {
  DEEPSEEK_MODEL_CATALOG,
  DEFAULT_DEEPSEEK_MODEL,
  DEFAULT_DEEPSEEK_REASONING_EFFORT,
} from "./server/models.js";

export const type = "deepseek_api";
export const label = "DeepSeek (API)";

export { DEFAULT_DEEPSEEK_MODEL, DEFAULT_DEEPSEEK_REASONING_EFFORT };

export const models = DEEPSEEK_MODEL_CATALOG.map((model) => ({
  id: model.id,
  label: model.label,
}));

export const agentConfigurationDoc = `# deepseek_api agent configuration

Adapter: deepseek_api
Registration: external plugin (npm package \`paperclip-adapter-deepseek\`)

The adapter drives DeepSeek V4 models directly through the DeepSeek API
(OpenAI-compatible chat completions with native function calling). The adapter
runs the agentic loop itself (Paperclip only calls execute() once per
heartbeat): the model receives a system prompt that explains the Paperclip
heartbeat protocol and a set of tools (shell, files, Paperclip API, skills, MCP
servers), the adapter executes tool calls, feeds results back, persists the
conversation between heartbeats and reports usage/cost.

Use when:
- You want a DeepSeek-powered employee agent without installing a third-party CLI
- The agent must talk to the Paperclip control plane with structured, validated tool calls
- You want cheap long-running sessions (1M-token context, prompt caching) with thinking mode
- You need company MCP connections and runtime connection tools exposed to a DeepSeek model

Don't use when:
- The runtime must be Claude Code / Codex / Cursor for their native tooling (use claude_local, codex_local, cursor)
- You only need a one-shot script without an AI loop (use process)
- You want a webhook-driven external service (use http)
- The agent must run on a remote SSH/sandbox execution target (this adapter runs on the Paperclip host only)

Core fields:
- cwd (string, strongly recommended): absolute working directory for shell/file tools; created when missing. An execution workspace cwd overrides it. When neither is set the adapter falls back to the Paperclip server process directory (Test environment warns with deepseek_cwd_unset)
- model (string, optional): DeepSeek model id, chosen in the form's model dropdown. Default: ${DEFAULT_DEEPSEEK_MODEL}. Known ids: deepseek-v4-flash, deepseek-v4-pro
- reasoningEffort (string, optional): "none" (thinking disabled), "low", "high" (default) or "max". When unset the form's Thinking effort control applies (stored as thinkingEffort / effort; medium counts as high, off/disabled as none, xhigh as max)
- instructionsFilePath (string, optional): markdown instructions (AGENTS.md) prepended to the system prompt
- promptTemplate (string, optional): heartbeat prompt template ({{agent.id}}, {{agent.name}}, {{context.taskId}}, ...)
- bootstrapPromptTemplate (string, optional): extra prompt sent only when a fresh session starts
- env (object, optional): environment variables (supports secret refs). DEEPSEEK_API_KEY is required here or in the server environment
- apiKeyEnvVar (string, optional): name of the env var that carries the API key. Default DEEPSEEK_API_KEY
- baseUrl (string, optional): API base URL. Default https://api.deepseek.com

Loop and safety fields:
- maxTurns (number, optional): maximum model turns per heartbeat. Default 80
- maxTokens (number, optional): completion token cap per turn; unset uses the API default
- temperature / topP (number, optional; top_p accepted): sampling; ignored by DeepSeek in thinking mode
- stream (boolean, optional): stream deltas into the run log. Default true
- strictTools (boolean, optional): use DeepSeek strict function calling (beta endpoint; free-form object parameters stay open, validation keywords are enforced locally). Default false
- timeoutSec (number, optional): whole heartbeat timeout. Default 3600; 0 disables
- graceSec (number, optional): grace period before force-killing shell commands. Default 15
- shellTimeoutSec (number, optional): default timeout for run_shell. Default 120
- shellMaxTimeoutSec (number, optional): upper bound a tool call may request. Default 1800
- shell (string, optional): shell binary for run_shell. Default bash, else sh
- maxToolOutputChars (number, optional): tool output cap before truncation. Default 30000
- maxFileReadChars (number, optional): read_file / load_skill cap. Default 100000
- disabledTools (string[], optional): tool names the model must not get (e.g. ["run_shell"])
- mcpEnabled (boolean, optional): expose Paperclip runtime MCP servers as tools. Default true
- connectionToolsEnabled (boolean, optional): expose connections_search / connection_request. Default true
- compactionThresholdTokens (number, optional): summarize old context above this prompt size. Default 240000
- compactionKeepRecentMessages (number, optional): messages kept verbatim after compaction. Default 16
- sessionsDir (string, optional): where conversation transcripts are stored. Default <PAPERCLIP_HOME or ~/.paperclip>/instances/<instanceId>/adapters/deepseek_api/sessions
- sessionMaxAgeDays (number, optional): delete transcripts not written for this many days (housekeeping of sessionsDir). Default 0 (disabled)
- skillsDir (string, optional): extra directory of Paperclip skills made loadable via load_skill
- exposeApiKeyToShell (boolean, optional): let run_shell see the DeepSeek key (from env or the server process). Default false (the key is removed from the shell environment)
- pricing (object, optional): per-model USD prices per 1M tokens {cacheHitPerMTok, cacheMissPerMTok, outputPerMTok}
- requestTimeoutSec / idleTimeoutSec / maxRetries (numbers, optional): API request limits. Defaults 600 / 180 / 4

Notes:
- Sessions resume when the saved session cwd matches the current cwd; otherwise a fresh conversation starts. A failure before the model is called (missing key, invalid cwd) keeps the previous session.
- Reaching maxTurns ends the run as failed with errorCode max_turns_exhausted (Paperclip's max-turn continuation resumes the transcript); an empty final response without finish_run fails with deepseek_empty_response.
- finish_run only records the disposition and summary; the issue status is whatever the agent wrote via paperclip_api. Leaving an issue in_progress without a live continuation path makes Paperclip post "needs a disposition" and re-wake the agent immediately. Server-verified external-chat turns follow the injected contract (no API calls, the finish_run summary is the reply); the adapter cannot report the native \`yielded\` disposition, so it cannot keep a chat task open waiting for the user's next message.
- Thinking mode keeps reasoning_content on assistant messages, as DeepSeek requires for tool-calling rounds.
- Costs are estimated from prompt_cache_hit_tokens / prompt_cache_miss_tokens / completion_tokens with the built-in price table unless overridden.
- The run log is JSONL (deepseek.* events) rendered live by the bundled UI parser.
- Only the company skills assigned to the agent (plus the operational paperclip skill, skillsDir and bundled skills) are loadable at run time; assigned skills whose files are missing show as missing in the Skills panel.
- run_shell returns when the shell exits; background helpers must redirect their output, and the process group is killed on timeout. The per-run scratch directory is named in the heartbeat facts.
`;

// Required by Paperclip's plugin-loader convention: the package root must
// export createServerAdapter().
export { createServerAdapter } from "./server/index.js";
