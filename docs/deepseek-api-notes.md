# DeepSeek API notes

What this adapter relies on, verified against the official documentation at
<https://api-docs.deepseek.com> on **2026-09-11** and against a live run with a
real API key on the same day. Pages read: Models & Pricing, Thinking Mode, Tool
Calls, Create Chat Completion, Error Codes.

## Endpoints and authentication

- OpenAI-compatible base URL `https://api.deepseek.com`; `POST /chat/completions`
  and `GET /models`.
- Strict function calling requires the Beta base URL `https://api.deepseek.com/beta`.
- Anthropic-compatible base URL `https://api.deepseek.com/anthropic` (not used here).
- Header `Authorization: Bearer <DEEPSEEK_API_KEY>`.
- `GET /models` on 2026-09-11 returned exactly `deepseek-flash` and `deepseek-v4-pro`.

## Models

| API id | Serves | Notes |
|--------|--------|-------|
| `deepseek-flash` | DeepSeek-V4.1-Flash | Current name. Vision supported. |
| `deepseek-v4-pro` | DeepSeek-V4-Pro-0813 | From 2026-09-14 12:00 Beijing (04:00 UTC) routed to V4.1 Flash and billed at the Flash price; being retired. No vision. |
| `deepseek-v4-flash`, `deepseek-v4-flash-vision-exp` | DeepSeek-V4.1-Flash | Legacy names, still accepted, billed at the Flash price. |
| `deepseek-chat`, `deepseek-reasoner` | — | Retired July 2026. |

Both models: **1M context**, **max output 384K (393216)** tokens, tool calls,
JSON output, thinking mode.

## Thinking mode

Quoting the Thinking Mode page:

- Toggle: `{"thinking": {"type": "enabled"}}` or `{"type": "disabled"}`.
- Effort: `{"reasoning_effort": "low"|"high"|"max"}`. `none` disables thinking.
- **Thinking is enabled by default and the default effort is `high`.**
- Requested effort is mapped: `minimal`→low, `low`→low, `medium`→high,
  `high`→high, `xhigh`→high, `max`→max, `ultra`→max. Only `none|low|high|max`
  are valid values of `reasoning_effort`.
- `temperature`, `presence_penalty` and `frequency_penalty` have **no effect**
  in thinking mode (they are accepted without error).
- `top_p` **does take effect** in thinking mode with a lower bound of `0.95`;
  in non-thinking mode it is fixed at `1.0` and the passed value is ignored.
- The chain of thought is returned in `reasoning_content`, alongside `content`.

**The rule that matters most for an agent loop:**

> If the request carries the `tools` parameter: the `reasoning_content` of all
> previous turns should be passed back to the API and will be concatenated into
> the context. […] the `reasoning_content` must be fully passed back to the API
> in all subsequent requests — even for turns where the model did not perform a
> tool call. If your code does not correctly pass back `reasoning_content`, the
> API will return a 400 error.

Without `tools`, `reasoning_content` is ignored. The adapter therefore keeps
reasoning on every assistant turn and replays it, which is the `full` policy in
`agent-loop.ts`; the narrower policies remain only as a fallback if a future API
version rejects the shape.

## Tool calls

- Standard OpenAI shape: `tools[].function.{name,description,parameters}`,
  response `message.tool_calls[]`, results as `{role:"tool", tool_call_id, content}`.
- `tool_choice`: `none`, `auto`, `required`, or a named function. **`required`
  and named choices are not supported in thinking mode** and return a 400;
  `none` and `auto` are fine. The adapter only uses `auto` and `none`.
- The Chat Completion API does **not** support inserting tool calls
  mid-conversation (only the Anthropic and Responses APIs do).
- Strict mode: set `strict: true` on each function and use the `/beta` base URL.
  The server validates the schema and rejects unsupported constructs.
  Supported JSON Schema types in strict mode: `object`, `string`, `number`,
  `integer`, `boolean`, `array`, `enum`, `anyOf`. Every object must list all of
  its properties in `required` and set `additionalProperties: false`, which is
  why free-form objects cannot be expressed under strict mode.

## Request and response details

- `max_tokens`: 1 to 393216. When unset the default is **8K in non-thinking
  mode, 64K in thinking mode, 128K with `reasoning_effort: max`**. The adapter
  leaves it unset unless configured, so these defaults apply.
- Usage: `prompt_tokens` equals `prompt_cache_hit_tokens + prompt_cache_miss_tokens`;
  `prompt_tokens_details.cached_tokens` mirrors the hit count;
  `completion_tokens_details.reasoning_tokens` is part of `completion_tokens`.
- Error codes: 400 invalid format, 401 authentication, 402 insufficient balance,
  422 invalid parameters, 429 rate limit, 500 server error, 503 overloaded.

## Pricing

USD per 1M tokens, from the Models & Pricing page.

| | deepseek-flash | deepseek-v4-pro |
|---|---|---|
| Input, cache hit (off-peak / peak) | 0.003 / 0.006 | 0.022 / 0.044 |
| Input, cache miss (off-peak / peak) | 0.15 / 0.30 | 0.66 / 1.32 |
| Output (off-peak / peak) | 0.60 / 1.20 | 1.98 / 3.96 |

Peak hours are **01:00-04:00 and 06:00-10:00 UTC, Monday to Friday**; off-peak
rates are half the peak rates. Reasoning tokens bill at the output rate. The
adapter picks the tier from the run's start time and switches `deepseek-v4-pro`
to Flash pricing after 2026-09-14 04:00 UTC, matching the announced routing
change. An operator override in `adapterConfig.pricing` is a flat rate and wins
over both tiers.

## Verified live

A real run on 2026-09-11 with `deepseek-flash` confirmed: thinking mode with
visible `reasoning_content`, tool calls with arguments, prompt caching
(157056 cached of 173643 prompt tokens on a 13-turn task), and cost matching
this table to the last decimal at peak rates.

## Environment note

Node's `fetch` does not honour `HTTPS_PROXY` on its own. On a host behind a
proxy, start the Paperclip server with `NODE_USE_ENV_PROXY=1` (Node 24+),
otherwise the adapter's requests bypass the proxy and fail.
