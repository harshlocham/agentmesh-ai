# Local vLLM or TGI

Use the OpenAI-compatible provider against a local gateway.

```bash
export LLM_PROVIDER=openai-compatible
export LLM_API_KEY=dummy-key
export LLM_BASE_URL=http://localhost:8000/v1
export LLM_MODEL=Qwen/Qwen2.5-7B-Instruct
```

For local deployments, keep `LLM_SUPPORTS_RESPONSES_API=false` if the server only exposes chat completions.

```bash
export LLM_SUPPORTS_RESPONSES_API=false
export LLM_SUPPORTS_JSON_MODE=false
```

The startup validator and provider metrics are intentionally lightweight so the worker can boot quickly in hackathon-style deployments.