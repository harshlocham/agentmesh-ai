# Deployment Checklist

## Pre-Deployment Verification

### Environment Configuration
- [ ] `LLM_PROVIDER` is set (e.g., `openai`, `amd-openai-compatible`, `huggingface`)
- [ ] `LLM_API_KEY` or provider-specific key is configured
- [ ] `LLM_MODEL` is specified and available in the provider
- [ ] `TASK_AGENT_LLM_TIMEOUT_MS` is set (recommended: 45000ms for AMD, 30000ms for OpenAI)
- [ ] `TASK_AGENT_TOOL_TIMEOUT_MS` is set (recommended: 30000ms)
- [ ] `TASK_AGENT_ITERATION_TIMEOUT_MS` is set (recommended: 90000ms)
- [ ] `TASK_LEASE_MS` is set (default: 30000ms)
- [ ] `TASK_AGENT_MAX_ITERATIONS` is set (recommended: 3-5)

### Provider Capability Flags
- [ ] `LLM_SUPPORTS_RESPONSES_API` is set appropriately (false for OSS models via TGI/vLLM)
- [ ] `LLM_SUPPORTS_JSON_MODE` is set appropriately (false for chat-completions-only gateways)
- [ ] `LLM_LOG_REQUESTS` is unset or false for production (reduce verbosity)

### Database and Services
- [ ] MongoDB connection is available
- [ ] Redis connection is available (if using presence service)
- [ ] Task collection exists and is indexed
- [ ] TaskPlan collection exists and is indexed

### Tools Configuration
- [ ] `GITHUB_TOKEN` is set (for create-issue tool)
- [ ] `GITHUB_REPO` is set (format: `owner/repo`)
- [ ] `RESEND_API_KEY` is set (for send-email tool)
- [ ] `RESEND_FROM_EMAIL` is set
- [ ] `SCHEDULE_MEETING_WEBHOOK_URL` is set (if using schedule-meeting tool)

## Startup Validation

Run the startup health check:
```bash
npm run validate:startup
```

Expected output:
```json
{
  "provider": "openai|amd-openai-compatible|huggingface",
  "model": "gpt-4o-mini|meta-llama/Llama-3.1-8B-Instruct|etc",
  "status": "healthy|degraded|offline",
  "checks": {
    "provider": { "ok": true, "latencyMs": 150 },
    "model": { "ok": true },
    "capabilities": { "responses_api": false, "json_mode": false },
    "tools": { "email": true, "issue": true, "meeting": true }
  },
  "recommendations": [
    "LLM_SUPPORTS_RESPONSES_API is false; using chat-completions fallback path"
  ]
}
```

## Deployment Steps

### 1. Local Dev/Demo
```bash
cd apps/task-worker
export LLM_PROVIDER=openai
export OPENAI_API_KEY=sk-...
export LLM_MODEL=gpt-4o-mini
npm run dev
```

### 2. Production AMD Deployment (via Docker)
```bash
export LLM_PROVIDER=amd-openai-compatible
export AMD_API_KEY=your-token
export AMD_BASE_URL=https://your-amd-gateway.example/v1
export LLM_MODEL=meta-llama/Llama-3.1-8B-Instruct
export TASK_AGENT_LLM_TIMEOUT_MS=45000
export TASK_AGENT_MAX_ITERATIONS=3
docker-compose -f docker-compose.yml up --build
```

### 3. Test Execution
```bash
npm run test:provider    # Verify provider behavior
npm run test:runtime      # Verify runtime reliability
```

## Post-Deployment Validation

### Provider Health Check
```bash
curl -X POST http://localhost:3000/health \
  -H "Content-Type: application/json" \
  -d '{"check": "provider"}'
```

Expected response:
```json
{
  "ok": true,
  "provider": "amd-openai-compatible",
  "latencyMs": 250,
  "model": "meta-llama/Llama-3.1-8B-Instruct"
}
```

### Task Execution Smoke Test
```bash
curl -X POST http://localhost:3000/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Send welcome email",
    "description": "Send email to team@example.com",
    "maxIterations": 3
  }'
```

Expected:
- Task is created with status `pending`
- Within 30 seconds, task transitions to `executing`
- LLM generates a plan and selects the `send_email` tool
- Tool executes successfully
- Task transitions to `completed`

## Monitoring Post-Deployment

### Key Metrics
- **LLM Request Latency**: Target < 2s for Qwen/Mistral on AMD, < 500ms for GPT-4o-mini
- **Provider Fallback Rate**: Should be < 5% (transient failures only)
- **Tool Execution Success**: Should be > 95%
- **Iteration Timeout**: Monitor `TASK_AGENT_ITERATION_TIMEOUT_MS` overruns

### Log Patterns to Watch
- **Healthy**: `llm:request`, `llm:response`, `step:execute`, `step:verify`, `lifecycle:completed`
- **Warning**: `llm:downgrade` (indicates Responses API fallback; expected for OSS models)
- **Error**: `llm:error` with category `auth` or `non_retryable` (requires human intervention)

### Graceful Degradation
If provider becomes unavailable:
1. LLM errors are retried up to `TASK_AGENT_MAX_ITERATIONS` times
2. After max iterations, task transitions to `failed` with error reason
3. Fallback recommendations are logged to guide remediation

## Rollback Procedure

If deployment fails or provider becomes unreliable:
1. Switch `LLM_PROVIDER` to a known-good provider (e.g., `openai`)
2. Restart the worker service
3. Existing tasks in `executing` state will resume with the new provider
4. Monitor logs for successful recovery

## Known Limitations

- Responses API is only available on OpenAI and verified OpenAI-compatible gateways
- OSS models via vLLM/TGI use chat-completions fallback (no structured output guarantee)
- Tool side effects are idempotent within a run but may require cleanup across runs
- Max iteration limit prevents infinite loops; long-running tasks may not complete within one run

## AMD Production Tuning

For reliable AMD deployments:

| Setting | Recommended | Rationale |
|---------|-------------|-----------|
| `TASK_AGENT_LLM_TIMEOUT_MS` | 45000 | OSS models are slower than GPT-4o-mini |
| `TASK_AGENT_TOOL_TIMEOUT_MS` | 30000 | Tool latency (API calls) can spike |
| `TASK_AGENT_ITERATION_TIMEOUT_MS` | 90000 | Full iteration (LLM + tool + verify) needs breathing room |
| `TASK_AGENT_MAX_ITERATIONS` | 3-5 | Limit iterations to avoid long-running tasks |
| `LLM_SUPPORTS_RESPONSES_API` | false | Most OSS gateways don't support it |
| `LLM_SUPPORTS_JSON_MODE` | false | Not all OSS models enforce JSON strictly |

## Support Contacts

- **Provider Issues**: Check `llm:error` logs for category (auth, timeout, rate_limit, etc.)
- **Tool Issues**: Review `step:tool-failure` logs for reason and idempotency key
- **Runtime Timeouts**: Consider increasing `TASK_AGENT_LLM_TIMEOUT_MS` or `TASK_AGENT_ITERATION_TIMEOUT_MS`
- **Lease Loss**: Check worker heartbeat health; may indicate database or Redis connectivity issues
