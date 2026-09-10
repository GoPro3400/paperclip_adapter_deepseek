# DeepSeek API notes used by this adapter

Snapshot of what the adapter relies on and where each fact comes from. The
official documentation site (https://api-docs.deepseek.com) was not reachable
from the environment in which the adapter was written, so facts are graded.

Legend: **[official]** = published by DeepSeek (Hugging Face model cards and
encoding reference of the `deepseek-ai` organisation), **[registry]** = the
models.dev provider registry which mirrors the official pricing page with an
access date, **[secondary]** = third-party write-ups, **[assumed]** = adapter
behaviour chosen defensively where no source was available.

## Endpoints

- Base URL `https://api.deepseek.com`, OpenAI-compatible `POST /chat/completions`
  and `GET /models`; strict function calling lives on `https://api.deepseek.com/beta`.
  [registry: models.dev provider.toml; secondary]
- Authentication: `Authorization: Bearer <DEEPSEEK_API_KEY>`. [registry]

## Models (September 2026)

| API id | Notes |
|--------|-------|
| `deepseek-v4-flash` | Official since 2026-07-31 (`DeepSeek-V4-Flash-0731`). models.dev (accessed 2026-09-10) notes requests are now served by the newer Flash-tier weights (`DeepSeek-V4.1-Flash`) and billed at the Flash price. [official card + registry] |
| `deepseek-v4-pro` | GA 2026-08-13 (`DeepSeek-V4-Pro-0813`). [official card] |
| `deepseek-chat`, `deepseek-reasoner` | Legacy aliases, retired 2026-07-24. [secondary, several independent sources] |

- Context length 1M tokens for V4 Pro and V4 Flash. [official cards]
- Recommended max output: 384K for V4 Pro at high/max effort, ≥256K for V4.1 Flash. [official cards]
- Recommended sampling for agentic work: `temperature = 1.0`, `top_p = 0.95`. [official cards]
- `DeepSeek-V4.1-Flash` (released 2026-09-10 on Hugging Face) supports a
  continuously controllable reasoning effort (integer 1–100) at the model level;
  the API id and API-level parameter shape for it are unverified. [official card; API mapping unknown]

## Thinking mode

- Request fields: `thinking: { "type": "enabled" | "disabled" }` and
  `reasoning_effort`. [registry: models.dev comments citing the official create-chat-completion page]
- `reasoning_effort` accepts `low`, `high`, `max` since the 0813 release
  ("The reasoning_effort parameter now supports three levels — low, high, and max"). [official V4-Pro-0813 card]
- Sampling parameters have no effect while thinking is enabled. [secondary; consistent with V3.x docs]
- The assistant message carries `reasoning_content` next to `content`. [official encoding README]
- Multi-turn rule from the official V4 encoding reference: without tools,
  reasoning of turns before the last user message is dropped (`drop_thinking`);
  **with tools present, all turns retain their reasoning** because tool-calling
  conversations need the full chain. [official encoding README]
- LiteLLM injects a placeholder `reasoning_content` on assistant messages in
  thinking mode "to satisfy API validation". [secondary: BerriAI/litellm source]
- Adapter behaviour: store `reasoning_content` on every assistant turn, send it
  back for all turns (placeholder `" "` when missing), and on a 400 mentioning
  `reasoning_content`/thinking retry with current-round-only, then none. [assumed]

## Function calling

- OpenAI-compatible `tools: [{type:"function", function:{name, description, parameters}}]`,
  `tool_choice`, response `message.tool_calls[{id, type:"function", function:{name, arguments}}]`,
  `finish_reason: "tool_calls"`, tool results as `{role:"tool", tool_call_id, content}`.
  [official encoding README describes the OpenAI-compatible message format; secondary]
- Streaming emits `delta.tool_calls[{index, id, function:{name, arguments}}]` fragments. [assumed: OpenAI-compatible]
- Strict mode: `strict: true` on the function definition, requests to the beta base URL. [secondary]
- Usage fields: `prompt_tokens`, `completion_tokens`, `prompt_cache_hit_tokens`,
  `prompt_cache_miss_tokens`, `completion_tokens_details.reasoning_tokens`,
  `prompt_tokens_details.cached_tokens`. [registry comment + secondary]

## Pricing (USD per 1M tokens, models.dev accessed 2026-08-12 / 2026-09-10)

| Model | cache hit | cache miss | output |
|-------|-----------|------------|--------|
| deepseek-v4-pro | 0.003625 | 0.435 | 0.87 |
| deepseek-v4-flash (served by V4.1 Flash) | 0.003 | 0.15 | 0.60 |

Reasoning tokens are billed at the output rate. DeepSeek applies time-of-day
discounts; treat the table as an estimate and override per agent when exact
accounting matters. [registry]

## Error codes

400 invalid format, 401 authentication, 402 insufficient balance, 422 invalid
parameters, 429 rate limit, 500 server error, 503 overloaded. [secondary, matches V3-era docs]

## Open questions to confirm against the official docs

1. Exact `reasoning_content` validation rules for turns before the last user message in tool-calling conversations.
2. Default and maximum `max_tokens` for V4 Pro / Flash.
3. Whether a `deepseek-v4.1-flash` API id exists and how numeric reasoning effort is exposed.
4. Current peak/off-peak pricing windows and the exact list prices.
5. Rate-limit headers and recommended retry behaviour.
