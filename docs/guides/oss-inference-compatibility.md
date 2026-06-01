# OSS Inference Compatibility

## Purpose

The task worker's autonomous agent talks to an LLM through a thin provider
abstraction in `apps/task-worker/services/llm/`. This guide describes which
OSS inference stacks are supported, how to configure them, what works and
what doesn't, and what degradation paths the worker takes when a backend
exposes only a subset of the OpenAI surface.

It is grounded in the actual code in:

- `apps/task-worker/services/llm/provider-factory.ts`
- `apps/task-worker/services/llm/providers/openai-provider.ts`
- `apps/task-worker/services/llm/providers/huggingface-provider.ts`
- `apps/task-worker/services/llm/types.ts`
- `apps/task-worker/services/llm/response-parser.ts`
- `apps/task-worker/services/llm/startup.ts`
- `apps/task-worker/services/llm/recommendations.ts`

Ready-to-use environment recipes live under `examples/`:

- `examples/local-vllm-tgi.md` — local vLLM or TGI.
- `examples/huggingface-inference-endpoints.md` — HF Serverless / HF
  Inference Endpoints.
- `examples/amd-openai-compatible.md` — AMD-backed OpenAI-compatible
  gateway.
- `examples/amd-production-env.md` — full production-tuned env block.

## Supported Providers (Provider Matrix)

The provider type is selected by the `LLM_PROVIDER` env (or
`TASK_LLM_PROVIDER` as fallback) and validated against the enum in
`LLMProviderConfig.provider` (`types.ts:37`):

| `LLM_PROVIDER` | Concrete class | Transport options | Intended backends |
|---|---|---|---|
| `openai` | `OpenAIProvider` | Responses API + chat-completions fallback | Hosted OpenAI. |
| `openai-compatible` | `OpenAIProvider` | Responses API + chat-completions fallback | vLLM, TGI, llama-cpp-server, any gateway exposing `/v1/chat/completions` (optionally `/v1/responses`). |
| `amd-openai-compatible` | `OpenAIProvider` (with capability overrides) | Chat-completions only (defaults) | AMD-friendly gateways behind vLLM/TGI. |
| `huggingface` | `HuggingFaceProvider` | `inference-api` (HF JSON envelope) or `openai-compatible` (HF Inference Endpoints `/v1`) | HF Serverless, HF Inference Endpoints. |

Provider routing happens in `createLLMProvider` (`provider-factory.ts:89`).
Anything outside the enum throws `LLMError("Unsupported LLM provider …")`
with `LLM_PROVIDER_NOT_SUPPORTED`.

## Environment Surface

These are the variables the factory reads. The first non-empty value
wins; nothing here is required to exist, but a few must be set for the
provider to be functional (see "Required for…" column).

| Variable | Default | Purpose | Required for |
|---|---|---|---|
| `LLM_PROVIDER` or `TASK_LLM_PROVIDER` | `openai` | Pick provider class. | All non-OpenAI backends. |
| `LLM_API_KEY` / `OPENAI_API_KEY` / `HUGGINGFACE_API_KEY` / `AMD_API_KEY` | empty | First non-empty wins. Sent as `Authorization: Bearer ...`. | All backends. |
| `LLM_BASE_URL` / `OPENAI_BASE_URL` / `HUGGINGFACE_BASE_URL` / `AMD_BASE_URL` | provider-default | Override gateway URL. First non-empty wins. | Non-OpenAI backends. |
| `LLM_MODEL` / `TASK_AGENT_MODEL` / `HUGGINGFACE_MODEL` | empty | Model identifier passed to the provider. | All backends. |
| `TASK_AGENT_LLM_TIMEOUT_MS` / `LLM_REQUEST_TIMEOUT_MS` | `30000` | Per-request timeout. Composed with `signal` on every call. | Optional. |
| `LLM_LOG_REQUESTS` | `true` (any value `!== "false"`) | Emits `llm:request` / `llm:response` / `llm:error` / `llm:downgrade` console logs. | Optional. |
| `LLM_PROVIDER_PROFILE` | matches provider name | Free-form profile label surfaced in logs. | Optional. |
| `LLM_SUPPORTS_RESPONSES_API` | `true` for OpenAI, **`false`** for HF and AMD | Toggles the `responses.create` call path. | Critical for OSS — see below. |
| `LLM_SUPPORTS_STRUCTURED_OUTPUTS` | `true` (overridden for HF) | Capability flag exposed by `supportsStructuredOutputs()`. | Optional. |
| `LLM_SUPPORTS_TOOL_CALLING` | `true` for OpenAI, `false` for HF | Capability flag exposed by `supportsToolCalling()`. | Optional. |
| `LLM_SUPPORTS_STREAMING` | `true` | Capability flag (currently unused by the agent — see Limitations). | Optional. |
| `LLM_SUPPORTS_JSON_MODE` | `true` for OpenAI, **`false`** for HF and AMD | Whether `response_format: { type: "json_object" }` is supported. | Critical for OSS — see below. |
| `HUGGINGFACE_OPENAI_COMPATIBLE` | inferred from URL suffix `/v1` | Forces HF transport to `openai-compatible` or `inference-api`. | Optional override. |

Reference: `provider-factory.ts:23-58` for the precedence chain, and
`provider-factory.ts:60-81` for the per-provider capability defaults
(`applyProviderDefaults`).

### A note on env precedence

`HUGGINGFACE_API_KEY` is **not** the highest-priority key. The factory
reads `OPENAI_API_KEY || HUGGINGFACE_API_KEY || AMD_API_KEY || LLM_API_KEY`
in that order. If both `OPENAI_API_KEY` and `HUGGINGFACE_API_KEY` are
set, the OpenAI key is used — even when `LLM_PROVIDER=huggingface`. The
same precedence applies to `*_BASE_URL`. To avoid cross-contamination,
unset the unused vars or rely on `LLM_API_KEY`/`LLM_BASE_URL` as a single
source.

## How a Request Flows

```
AgentRunner / Planner / Reflection
        │
        ▼
createDefaultLLMProvider()           (provider-factory.ts:106)
        │
        ▼
BaseLLMProvider.generate(request, options)
        │
        ├── OpenAIProvider (also used for openai-compatible, amd-*)
        │      ├── if supportsResponsesApi() → POST /v1/responses
        │      │       └── on timeout/5xx/connection error → chat fallback
        │      └── else                       → POST /v1/chat/completions
        │
        └── HuggingFaceProvider
               ├── transport === "openai-compatible" → delegates to OpenAIProvider
               └── transport === "inference-api"     → POST {baseUrl}|api-inference.huggingface.co/models/<model>
                       with HF JSON envelope { inputs, parameters }
```

After a response is received, `extractResponseText` and
`parseJsonText` / `parseJsonWithSchema` (`response-parser.ts`)
normalize many shapes into a single string the agent can JSON-parse:

- OpenAI Responses `output[*].content[*].text` (`responses` format).
- OpenAI / vLLM / TGI / HF-`/v1` Chat Completions
  `choices[0].message.content` (`chat_completions` format).
- HF inference API `generated_text`, `text`, `content`
  (`normalized` format).
- Markdown-fenced JSON (` ```json ... ``` `) and trailing-garbage trimming.

The parser is intentionally forgiving: a successful repair sets
`parseRepaired: true`, which the metrics layer records via
`recordLLMProviderMetric({ event: "repair" })` callers (see Observability).

## Recipes

### Hosted OpenAI

```bash
export LLM_PROVIDER=openai
export OPENAI_API_KEY=sk-...
export LLM_MODEL=gpt-4o-mini
```

This is the default if `LLM_PROVIDER` is unset. The provider attempts
`/v1/responses` first and silently downgrades to `/v1/chat/completions`
on 5xx, timeout, or connection error (`openai-provider.ts:144-185`,
`shouldFallbackToChat` predicate).

### OpenAI-compatible gateway (vLLM, TGI, llama-cpp-server, generic)

`examples/local-vllm-tgi.md` is the canonical recipe:

```bash
export LLM_PROVIDER=openai-compatible
export LLM_API_KEY=dummy-key          # gateway will probably not check it
export LLM_BASE_URL=http://localhost:8000/v1
export LLM_MODEL=Qwen/Qwen2.5-7B-Instruct

# Most OSS gateways do NOT expose /v1/responses:
export LLM_SUPPORTS_RESPONSES_API=false
export LLM_SUPPORTS_JSON_MODE=false
```

**Why disable Responses API**: most OSS gateways implement only
`/v1/chat/completions`. If `LLM_SUPPORTS_RESPONSES_API=true` against
such a gateway, the worker tries `/v1/responses` first, takes a 404,
and falls back to chat completions. This adds ~1 RTT per call. Disable
the Responses path up front for cleaner logs and lower latency.

**Why disable JSON mode**: most OSS gateways do not implement
`response_format: { type: "json_object" }`. The provider does not
currently *send* `response_format` (see Limitations), so the flag is
informational. Setting `false` keeps the capability surface honest.

The agent will still parse JSON via the response parser's repair path
(code-fence stripping, trailing-trim), which works well with
instruction-tuned 7B+ models.

### HuggingFace Inference Endpoints (`/v1`)

```bash
export LLM_PROVIDER=huggingface
export HUGGINGFACE_API_KEY=hf_xxx
export HUGGINGFACE_BASE_URL=https://<your-endpoint>.endpoints.huggingface.cloud/v1
export HUGGINGFACE_OPENAI_COMPATIBLE=true
export HUGGINGFACE_MODEL=meta-llama/Llama-3.1-8B-Instruct
```

When `transport === "openai-compatible"`, `HuggingFaceProvider`
delegates to an internal `OpenAIProvider` instance
(`huggingface-provider.ts:60-67`). All the Responses-API fallback
behavior described above applies.

If your HF endpoint truly speaks `/v1/responses` (rare),
`LLM_SUPPORTS_RESPONSES_API=true` will work. Otherwise leave it as the
HF default of `false`.

### HuggingFace Serverless (`/models/<id>`)

```bash
export LLM_PROVIDER=huggingface
export HUGGINGFACE_API_KEY=hf_xxx
export HUGGINGFACE_MODEL=mistralai/Mistral-7B-Instruct-v0.3
# leave HUGGINGFACE_BASE_URL unset, leave HUGGINGFACE_OPENAI_COMPATIBLE=false
```

This is the `inference-api` transport. The provider POSTs to
`https://api-inference.huggingface.co/models/<model>` with the HF
envelope:

```json
{
  "inputs": "<rendered prompt>",
  "parameters": {
    "max_new_tokens": 512,
    "temperature": 0.2,
    "top_p": 0.95,
    "return_full_text": false
  }
}
```

The prompt is rendered by concatenating chat messages as
`role: content` lines (`huggingface-provider.ts:120-123`). **There is
no chat-template awareness.** This works adequately for instruction-tuned
models but is suboptimal for models with strict chat templates
(Llama-3.x, Qwen2.5). Prefer the `/v1` transport for those.

In this mode the provider's capability flags collapse to:

| Capability | Value |
|---|---|
| `supportsResponsesApi()` | `false` |
| `supportsStructuredOutputs()` | `false` |
| `supportsToolCalling()` | `false` |
| `supportsStreaming()` | falls back to config; default `false` here |
| `supportsJsonMode()` | `false` |

Token counts are **estimated**, not measured: `estimateUsage(text)` in
`huggingface-provider.ts:5-12` returns
`ceil(text.length / 4)` for both input and output. Do not trust HF
inference-API usage numbers for cost accounting.

### AMD OpenAI-compatible gateway

```bash
export LLM_PROVIDER=amd-openai-compatible
export AMD_API_KEY=your-token
export AMD_BASE_URL=https://your-gateway.example/v1
export LLM_MODEL=meta-llama/Llama-3.1-8B-Instruct
# defaults from provider-factory:
#   LLM_SUPPORTS_RESPONSES_API=false
#   LLM_SUPPORTS_JSON_MODE=false
```

This is `OpenAIProvider` with two capabilities pinned off by
`applyProviderDefaults` (`provider-factory.ts:72-78`). Functionally
identical to `openai-compatible` aside from the capability defaults
and the log label. The production-tuned variant lives in
`examples/amd-production-env.md` (timeouts, iteration caps, model
choices).

## Capability Negotiation Semantics

The capability flags drive control flow only in a few places today:

1. **`supportsResponsesApi()`** — gates the `/v1/responses` attempt
   in `OpenAIProvider.generate` (`openai-provider.ts:144`).
2. **Other flags** (`supportsStructuredOutputs`,
   `supportsToolCalling`, `supportsStreaming`, `supportsJsonMode`) are
   exposed on `BaseLLMProvider` and queryable by the agent / planner /
   reflection layer, but the agent runner does **not** branch on them
   today. See Limitations.

This means a gateway that advertises `supportsJsonMode = true` does
not change the agent's prompt or request body. The flags should be
treated as configuration documentation for now.

## Downgrade & Fallback Flow

The OpenAI-compatible provider has one runtime downgrade and no
cross-provider failover:

```
client.responses.create(...)
        │
        ├── 2xx → normalize via extractResponseText, return
        │
        └── error → normalizeError → LLMError
                │
                ├── shouldFallbackToChat(err)?
                │     ├── err.category === "timeout"             ✓
                │     ├── err.category === "retryable" and 5xx   ✓
                │     ├── err.code === "APIConnectionError"      ✓
                │     ├── err.code === "ECONNRESET"              ✓
                │     └── err.code === "ETIMEDOUT"               ✓
                │
                ├── true  → logs llm:downgrade, records "fallback" metric,
                │           retries the same request as chat.completions.create
                │
                └── false → rethrows the LLMError
```

Conditions where **no fallback** happens:

- `401`/`403` — auth error, bubbled to caller.
- `429` — rate limit, retried by upstream `RetryManager`, not by
  fallback.
- `4xx other than 429/timeout` — non-retryable; treated as a permanent
  request problem (malformed prompt, invalid model id).

There is **no provider-to-provider failover**. The
`recommendProviderForTaskProfile` function in
`recommendations.ts` returns a `fallbackProvider` field in its result,
but no caller uses it. Configuring a backup provider via env switch is
the only way to survive a primary provider being down.

## Startup Validation

`validateProviderStartup` (`provider-factory.ts:114`) is exposed for
boot-time use. It returns an `LLMProviderStartupReport`
(`types.ts:162-172`):

```json
{
  "provider": "openai-compatible",
  "model": "Qwen/Qwen2.5-7B-Instruct",
  "ok": true,
  "reachable": true,
  "authPresent": true,
  "modelConfigured": true,
  "endpointShapeValid": true,
  "responseFormat": "validated"
}
```

The check is intentionally minimal:

- For OpenAI / OpenAI-compatible / AMD: `client.models.list()`.
- For HuggingFace `inference-api`: a 1-token "health-check" POST.

It will fail fast on missing API keys or models, and report
`reachable: false` on auth failures, DNS resolution errors, or
5xx. It does **not** check whether the gateway actually accepts the
configured Responses API or JSON-mode flags. False positives are
possible against gateways that respond 2xx to `/v1/models` but reject
the request body shape of `/v1/chat/completions`.

`examples/local-vllm-tgi.md` calls out that the startup validator is
"intentionally lightweight so the worker can boot quickly in
hackathon-style deployments."

## Tested Model Combinations

Models explicitly referenced in `examples/amd-production-env.md`:

- `meta-llama/Llama-3.1-8B-Instruct` — "balanced latency and reliability."
- `Qwen/Qwen2.5-7B-Instruct` — "stronger JSON discipline."
- `mistralai/Mistral-7B-Instruct-v0.3` — "fast tool-routing and concise
  outputs."

These are the only model recommendations made by the repository. Other
instruction-tuned models in the same parameter class
(Phi-3-medium-instruct, Gemma-2-9B-it, etc.) are not exercised by the
codebase; they will work to the extent the gateway returns a parseable
JSON object for the agent's prompts.

## Observability

The provider layer emits structured console logs and accumulates
in-memory counters.

### Logs

Controlled by `LLM_LOG_REQUESTS` (default `true`). Four event names:

- `llm:request` — fields: `provider, model, requestId, timeoutMs,
  inputType`.
- `llm:response` — fields: `provider, model, requestId, responseFormat,
  hasOutputText, parseRepaired, usage`.
- `llm:downgrade` — fields: `provider, model, requestId, from, to,
  reason, status`. Fired when the Responses API falls back to chat
  completions, or when `supportsResponsesApi()` is false at start.
- `llm:error` — fields: `provider, model, requestId, timeoutMs, code,
  category, retryable, message`.

### Counters

`metrics.ts` keeps a `Map<provider, snapshot>` with these counters
(see `LLMProviderMetricSnapshot` in `types.ts:150-160`):

```
requestCount         total generate(...) calls
successCount         2xx with parseable text
timeoutCount         AbortError or "timed out"
fallbackCount        Responses → chat downgrades
malformedResponseCount  empty output_text after parsing
repairCount          (currently never emitted by provider code)
totalLatencyMs       sum of successful generate latencies
lastRequestAt        ISO timestamp of last request
```

Read via `getAllLLMProviderMetricsSnapshots()` from `metrics.ts:62`.
The repair counter is wired in `recordLLMProviderMetric` but **no
code path emits a `"repair"` event** — the parser silently sets
`parseRepaired: true` on the `LLMResponse` instead. See Limitations.

## Failure Handling

`LLMError` (`types.ts:61-140`) normalizes the failure surface. Error
categories that flow up to the agent runner:

| `category` | When | Retried by agent? |
|---|---|---|
| `timeout` | `AbortError`, "timed out" in message | Yes (transient_llm). |
| `rate_limit` | HTTP 429 | Yes (transient_llm). |
| `retryable` | HTTP ≥500, `APIConnectionError`, `ECONNRESET`, `ETIMEDOUT` | Yes (transient_llm). |
| `auth` | HTTP 401/403 | No. Fatal until env is fixed. |
| `unsupported_capability` | error message matches `/unsupported\|capability/i` | No. |
| `malformed_response` | error message matches `/json\|parse\|malformed/i` | No (LLM gave bad output; the agent re-prompts via a different path). |
| `non_retryable` | all other 4xx, validation failures | No. |

The classifier in `agent-runner` (`retry-classifier.ts`) recognizes
`LLM_ERROR:` prefixed messages and maps them to `transient_llm`
retries when appropriate. See `ADR-002` for the retry envelope.

## Tradeoffs

- **One concrete OpenAI client, multiple labels.** vLLM, TGI, AMD,
  and HF-`/v1` all share `OpenAIProvider` — only env labels and
  capability flags differ. Pro: one battle-tested code path. Con:
  bugs in `OpenAIProvider` affect every OSS gateway.
- **Forgiving JSON parser.** `response-parser.ts` tries the raw text,
  code-fence-stripped text, trailing-trimmed text, and combinations of
  both. This unblocks the long tail of OSS models that wrap JSON in
  prose. The cost is that a successful repair hides a model that
  routinely produces bad output — operators should grep
  `parseRepaired: true` in logs to detect this.
- **No chat templating for HF `inference-api`.** Prompts are joined as
  raw `role: content` lines. Adequate for fine-tuned chat models that
  recognize that format; suboptimal for models expecting `<|im_start|>`,
  `[INST]`, or other tokens.
- **Token usage is estimated** for HF `inference-api`. Do not use the
  reported usage for billing.
- **Single-provider deployment.** No provider failover at runtime.
  Operators choose one and accept its uptime.
- **Capability flags as documentation.** Most flags do not actually
  branch the agent today. They are checked by `BaseLLMProvider`
  consumers and surfaced in startup reports, but do not affect the
  prompt or request shape.

## Limitations

1. **`response_format: json_object` is not sent.** Even when
   `supportsJsonMode()` returns `true`, `OpenAIProvider.generate` does
   not include `response_format` in the request body. JSON discipline
   relies on the agent's prompt + the parser's repair heuristics.
2. **Streaming is not used.** `supportsStreaming` is queryable but the
   provider always awaits the full response. There is no chunked
   parsing path.
3. **Tool calling is not used.** `supportsToolCalling` is queryable
   but the agent uses its own tool-decision JSON schema
   (`step-execution-utils.ts:llmDecisionSchema`) rather than the
   provider's native tool-call protocol. This is portable across
   providers but ignores the better latency/reliability of native
   function calling on capable backends.
4. **Provider failover is unimplemented.** `ProviderRecommendation.fallbackProvider`
   is documentation only.
5. **`repair` metric is never emitted.** The metric counter exists but
   no code path calls `recordLLMProviderMetric({ event: "repair" })`.
   Use the `parseRepaired: true` field on `llm:response` logs instead.
6. **HF prompt rendering ignores chat templates.** No tokenizer-aware
   templating for the `inference-api` transport.
7. **Startup validation is shallow.** `models.list()` success does not
   imply that `chat.completions.create` with the configured model will
   succeed. Models that exist in the catalog but are unloaded by the
   gateway will pass startup and fail at runtime.
8. **Env precedence is OpenAI-first.** Mixed env (an `OPENAI_API_KEY`
   in `.env.local` plus `HUGGINGFACE_API_KEY` for the new provider)
   silently sends the OpenAI key to HuggingFace. Use `LLM_API_KEY` and
   `LLM_BASE_URL` for OSS deployments to avoid this trap.
9. **HF model id is URL-encoded into the path** when no base URL is
   set. Custom slugs with unusual characters may behave unexpectedly.

## Operational Checklist

Before a deploy against an OSS gateway, confirm:

1. `LLM_PROVIDER`, `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL` are set
   and the unrelated provider envs (`OPENAI_*`, `HUGGINGFACE_*`) are
   **unset** to avoid env-precedence surprises.
2. `LLM_SUPPORTS_RESPONSES_API=false` unless the gateway has been
   explicitly tested with `/v1/responses`.
3. `LLM_SUPPORTS_JSON_MODE=false` unless the gateway has been
   explicitly tested with `response_format: json_object` (note that
   the worker doesn't send this today, but the flag affects future
   code paths).
4. `TASK_AGENT_LLM_TIMEOUT_MS` is at least the gateway's p99 latency
   plus 5s. Hosted OpenAI tolerates 30s; local vLLM may need 45-60s
   for 7B-class models on commodity GPUs.
5. The model id matches **exactly** what the gateway has loaded;
   typos return `404` from chat-completions and fail with a
   `non_retryable` LLMError.
6. `validateProviderStartup({})` returns `ok: true` before the worker
   starts processing tasks (the task worker boot path can call this
   if wired in `apps/task-worker/index.ts`).
7. The first task's `llm:response` log shows
   `responseFormat: "chat_completions"` (or `"normalized"` for HF
   `inference-api`) and `hasOutputText: true`. A trailing run of
   `parseRepaired: true` means the model is producing dirty JSON and
   needs a stronger system prompt or a smaller temperature.

## Future Evolution

- Send `response_format: { type: "json_object" }` when
  `supportsJsonMode()` is true, gated on
  `provider-factory.ts` configuration.
- Wire native tool calling for backends that support it
  (`supportsToolCalling()` true); fall back to the JSON-schema path
  otherwise.
- Implement the `fallbackProvider` chain in `recommendProviderForTask`.
- Emit `recordLLMProviderMetric({ event: "repair" })` from
  `response-parser.ts` so dashboard counters reflect repair rate.
- Add chat-template rendering for HF `inference-api` keyed on the
  model id (Llama, Mistral, Qwen, Phi families).
- Replace the shallow `validateProviderStartup` with a real
  end-to-end smoke ("emit 5 tokens, parse JSON from a known prompt")
  to catch loaded-model mismatches.

## Uncertain

- Streaming behavior with OSS gateways is untested in this repository
  because the worker never opts into streaming.
- Cost/usage numbers for OpenAI-compatible gateways depend on what the
  gateway returns in `usage`; if the gateway does not return usage,
  the worker reports `undefined` and the metrics layer accumulates no
  token totals. Whether vLLM/TGI return usage at all is
  deployment-dependent.
- The exact behavior of HF Inference Endpoints' OpenAI-compatible
  surface against the `responses.create` call has not been verified
  against the current HF API; the configurable
  `LLM_SUPPORTS_RESPONSES_API` flag is the escape hatch.
