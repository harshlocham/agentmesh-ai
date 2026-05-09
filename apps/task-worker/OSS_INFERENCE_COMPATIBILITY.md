# OSS Inference Compatibility Guide

This task-worker LLM layer is designed to talk to OpenAI-compatible endpoints first.

## Supported endpoint types

- OpenAI Responses API
- OpenAI Chat Completions API
- vLLM OpenAI-compatible servers
- TGI OpenAI-compatible servers
- Hugging Face Inference Endpoints that expose OpenAI-compatible APIs
- AMD-hosted OpenAI-compatible OSS inference

## Environment variables

```bash
LLM_PROVIDER=openai-compatible
LLM_BASE_URL=http://localhost:8000/v1
LLM_API_KEY=local-dev
LLM_MODEL=Qwen/Qwen2.5-7B-Instruct
LLM_REQUEST_TIMEOUT_MS=30000
LLM_LOG_REQUESTS=true
LLM_SUPPORTS_JSON_MODE=true
LLM_SUPPORTS_STRUCTURED_OUTPUTS=true
LLM_SUPPORTS_TOOL_CALLING=true
LLM_SUPPORTS_STREAMING=true
```

## vLLM example

```bash
python -m vllm.entrypoints.openai.api_server \
  --model Qwen/Qwen2.5-7B-Instruct \
  --served-model-name qwen2.5-7b \
  --port 8000
```

Use:

```bash
LLM_PROVIDER=openai-compatible
LLM_BASE_URL=http://localhost:8000/v1
LLM_MODEL=qwen2.5-7b
```

## TGI example

```bash
text-generation-launcher \
  --model-id mistralai/Mistral-7B-Instruct-v0.3 \
  --port 8080
```

Use:

```bash
LLM_PROVIDER=openai-compatible
LLM_BASE_URL=http://localhost:8080/v1
LLM_MODEL=mistralai/Mistral-7B-Instruct-v0.3
```

## Hugging Face Inference Endpoint example

```bash
LLM_PROVIDER=openai-compatible
LLM_BASE_URL=https://your-endpoint.endpoints.huggingface.cloud/v1
LLM_API_KEY=hf_...
LLM_MODEL=meta-llama/Llama-3.1-8B-Instruct
```

## AMD-hosted OSS inference

```bash
LLM_PROVIDER=openai-compatible
LLM_BASE_URL=https://your-amd-endpoint.example.com/v1
LLM_API_KEY=amd_...
LLM_MODEL=Qwen/Qwen2.5-7B-Instruct
```

## Known limitations

- Some endpoints implement `/chat/completions` but not `/responses`.
- JSON mode is not guaranteed on OSS models; keep temperature low and rely on parser repair.
- Tool calling may be unsupported depending on server and model.
- Health checks may return false negatives on minimal OpenAI-compatible servers.

## Practical guidance

- Prefer instruct-tuned models for planner and decision prompts.
- Use strict JSON prompts and keep outputs small.
- Keep retry budgets low for OSS inference.
- Use the provider layer as the single integration point; do not reintroduce raw fetch calls.