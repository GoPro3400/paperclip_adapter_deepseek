# Changelog

## 0.1.0 — 2026-09-10

Initial release of the `deepseek_api` Paperclip adapter.

- DeepSeek V4 chat completions client with streaming, retries, usage parsing
  (cache hit/miss, reasoning tokens) and error classification.
- Agentic tool-calling loop with JSON-schema validation, reasoning_content
  persistence and fallback policies, turn limits, wrap-up summaries,
  repeated-failure intervention and context compaction.
- Tools: paperclip_api, run_shell, read_file, write_file, edit_file,
  list_directory, search_files, load_skill, finish_run, connection tools and
  runtime MCP servers.
- System prompt with the Paperclip heartbeat protocol, per-heartbeat facts,
  skills catalog and the bundled official `paperclip` skill.
- Session transcripts persisted between heartbeats, environment test,
  declarative config schema, UI transcript parser (contract 1.0.0), CLI
  formatter and cost estimation.
