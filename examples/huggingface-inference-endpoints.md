# Hugging Face Inference Endpoints

Use `LLM_PROVIDER=huggingface` for hosted HF endpoints or the serverless inference API.

```bash
export LLM_PROVIDER=huggingface
export HUGGINGFACE_API_KEY=hf_xxx
export HUGGINGFACE_MODEL=mistralai/Mistral-7B-Instruct-v0.3
export HUGGINGFACE_OPENAI_COMPATIBLE=false
```

If your endpoint exposes an OpenAI-compatible `/v1` surface, point `HUGGINGFACE_BASE_URL` at that endpoint and set `HUGGINGFACE_OPENAI_COMPATIBLE=true`.

```bash
export HUGGINGFACE_BASE_URL=https://your-endpoint.example/v1
export HUGGINGFACE_OPENAI_COMPATIBLE=true
```

The worker will downgrade capability flags automatically when the endpoint only supports plain text generation.