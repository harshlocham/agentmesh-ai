# AMD OpenAI-Compatible Endpoints

Use `LLM_PROVIDER=amd-openai-compatible` when the model is hosted behind an AMD-friendly OpenAI-compatible gateway such as vLLM or TGI.

```bash
export LLM_PROVIDER=amd-openai-compatible
export AMD_API_KEY=your-token
export AMD_BASE_URL=https://your-gateway.example/v1
export LLM_MODEL=meta-llama/Llama-3.1-8B-Instruct
```

This path keeps the orchestration engine unchanged while routing requests through the provider layer with chat-completions fallback and capability-aware defaults.