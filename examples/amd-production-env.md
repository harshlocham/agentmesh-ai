# AMD Production Environment

This profile is tuned for hackathon demos on AMD-backed OpenAI-compatible endpoints.

```bash
export LLM_PROVIDER=amd-openai-compatible
export AMD_API_KEY=your-token
export AMD_BASE_URL=https://your-amd-gateway.example/v1
export LLM_MODEL=meta-llama/Llama-3.1-8B-Instruct
export TASK_AGENT_LLM_TIMEOUT_MS=45000
export TASK_AGENT_TOOL_TIMEOUT_MS=30000
export TASK_AGENT_ITERATION_TIMEOUT_MS=90000
export TASK_LEASE_MS=30000
export TASK_AGENT_MAX_ITERATIONS=3
export LLM_SUPPORTS_RESPONSES_API=false
export LLM_SUPPORTS_JSON_MODE=false
```

Recommended models:
- `meta-llama/Llama-3.1-8B-Instruct` for balanced latency and reliability
- `Qwen/Qwen2.5-7B-Instruct` for stronger JSON discipline
- `mistralai/Mistral-7B-Instruct-v0.3` for fast tool-routing and concise outputs

Deployment notes:
- Prefer an OpenAI-compatible `/v1` gateway behind vLLM or TGI.
- Keep response-completion budgets short enough to recover from hung demos.
- Use `LLM_SUPPORTS_RESPONSES_API=false` unless the gateway has been explicitly verified with the Responses API.
- Keep `LLM_SUPPORTS_JSON_MODE=false` if the gateway is chat-completions only.
