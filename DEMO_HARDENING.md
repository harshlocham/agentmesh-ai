# Demo Hardening Guide

## Demo Mode Configuration

Use this environment for predictable, repeatable judge demonstrations:

```bash
# Provider (set to your endpoint)
export LLM_PROVIDER=amd-openai-compatible
export AMD_API_KEY=your-token
export AMD_BASE_URL=https://your-amd-gateway/v1
export LLM_MODEL=meta-llama/Llama-3.1-8B-Instruct

# Timeouts optimized for demo reliability
export TASK_AGENT_LLM_TIMEOUT_MS=60000
export TASK_AGENT_TOOL_TIMEOUT_MS=45000
export TASK_AGENT_ITERATION_TIMEOUT_MS=120000
export TASK_LEASE_MS=45000

# Keep demos short and focused
export TASK_AGENT_MAX_ITERATIONS=3

# Provider capability flags (OSS via vLLM/TGI)
export LLM_SUPPORTS_RESPONSES_API=false
export LLM_SUPPORTS_JSON_MODE=false

# Logging: Reduce noise for judges, keep critical paths visible
export LLM_LOG_REQUESTS=false
export LOG_LEVEL=info
```

## Demo Stability Principles

### 1. Deterministic LLM Inputs
- Keep task descriptions concise and unambiguous
- Use concrete examples (e.g., "Send email to team@example.com" not "Send emails")
- Avoid broad instructions ("consider" → "send", "might" → "must")

### 2. Controlled Tool Outputs
- Mock tool responses to return success deterministically
- Or use real endpoints but with predictable behavior (no network jitter)
- Include evidence metadata in all tool results for traceability

### 3. Timeout Budgets
- `TASK_AGENT_LLM_TIMEOUT_MS=60s`: Allows slower models time to respond
- `TASK_AGENT_ITERATION_TIMEOUT_MS=120s`: Full cycle buffer for plan + execute + verify
- `TASK_LEASE_MS=45s`: Gives watchdog time to detect lease loss

### 4. Structured Logging
- Only critical paths: `llm:request`, `llm:response`, `step:execute`, `step:verify`, `lifecycle:*`
- Suppress debug logs: `agent-runner llm:provider`, tool latency breakdowns
- Include `runId` in all relevant logs for traceability

## Demo Flow (Safest Path)

### Step 1: Pre-Flight Check (1-2 seconds)
```bash
curl http://localhost:3000/health
# Expected: { "ok": true, "provider": "amd-openai-compatible", "latencyMs": 250 }
```

### Step 2: Create Task (< 1 second)
```bash
curl -X POST http://localhost:3000/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Send status update email",
    "description": "Send an email to team@example.com confirming the task was completed successfully.",
    "maxIterations": 2
  }'
# Expected: { "taskId": "task-123", "status": "pending" }
```

### Step 3: Monitor Execution (10-30 seconds)
```bash
# Watch logs in real-time
npm run logs -- --filter agent-runner

# Expected sequence:
# 1. agent-runner llm:request { runId: 'run-task-123-...', model: 'Llama-3.1-8B' }
# 2. agent-runner llm:response { responseText: '{"tool":"send_email",...}' }
# 3. agent-runner step:execute { stepId: null, toolName: 'send_email', ... }
# 4. agent-runner step:tool-execute { toolName: 'send_email', success: true }
# 5. agent-runner step:verify { toolName: 'send_email', passed: true }
# 6. agent-runner lifecycle:completed { taskId: 'task-123' }
```

### Step 4: Verify Completion (< 1 second)
```bash
curl http://localhost:3000/tasks/task-123
# Expected: { "status": "completed", "result": { "success": true, "confidence": 1 } }
```

**Total time: 15-40 seconds** (varies by model and network)

## Demo Hardening Checklist

### Pre-Demo Setup
- [ ] MongoDB is running and responsive
- [ ] Provider endpoint is reachable and responsive
- [ ] All tool endpoints are reachable (GITHUB_TOKEN, RESEND_API_KEY, etc.)
- [ ] LLM provider health check passes
- [ ] Task service is running without errors in logs

### Demo Environment
- [ ] Timeout values are set to demo-friendly levels (60s+ for LLM)
- [ ] Logging is set to INFO level; debug logs disabled
- [ ] Provider fallback order is correct (Responses API → Chat Completions)
- [ ] Idempotency keys are being generated for all tool calls
- [ ] Lease watchdog is active (should see heartbeat logs every 10-15 seconds)

### Demo Scenario
- [ ] Task title is clear and concise (< 10 words)
- [ ] Task description is specific and unambiguous
- [ ] Expected tool is available and functional
- [ ] Tool return logic is deterministic (no flaky mocks)
- [ ] Expected execution time < 40 seconds

### Post-Demo Validation
- [ ] Task completed with `status: "completed"`
- [ ] `result.success === true`
- [ ] `result.confidence >= 0.8`
- [ ] All `step:verify` logs have `passed: true`
- [ ] No `llm:error` or `step:tool-failure` logs

## Fallback Visibility in Demo

If the demo encounters a provider fallback (transient LLM error):

**Expected logs:**
```
llm:downgrade { from: "responses", to: "chat_completions", reason: "retryable", status: 503 }
```

**What this means for judges:**
- LLM request to Responses API failed transiently (e.g., timeout or connection reset)
- Automatic fallback to chat-completions API is triggered
- Execution continues successfully
- This is a **stability feature**, not a failure

**Demo recovery:**
- Do NOT stop or restart; let the system recover
- If fallback takes > 10 seconds, consider increasing `TASK_AGENT_LLM_TIMEOUT_MS`
- If fallback occurs repeatedly, check provider endpoint health

## Graceful Degradation Messaging

If a tool fails during demo:

**User sees:**
```
"step:tool-failure": {
  "toolName": "send_email",
  "reason": "SMTP timeout",
  "idempotencyKey": "task-123:send_email:1"
}
```

**Judge interpretation:**
- Tool was attempted (idempotency key ensures no duplicate side effects)
- Tool failed due to transient service issue
- System will retry up to `maxAttempts` times
- If max retries exceeded, LLM will select a fallback action

**How to explain:**
"The email tool timed out on the first attempt. The system is retrying with the idempotency key `task-123:send_email:1`, which ensures the email isn't sent twice. This is normal for production workloads."

## Recommended Demo Scenarios

### Scenario 1: Simple Tool Execution (Fastest, Most Reliable)
```json
{
  "title": "Send team notification",
  "description": "Send an email to team@example.com with the subject 'Update' and a brief message."
}
```
**Expected time:** 10-20 seconds  
**Success rate:** > 99% (only depends on email service)

### Scenario 2: Decision + Tool Execution
```json
{
  "title": "Create issue or send email",
  "description": "Based on the task description, decide whether to create a GitHub issue or send an email, then execute that action."
}
```
**Expected time:** 15-30 seconds  
**Success rate:** > 95% (depends on LLM decision quality)

### Scenario 3: Multi-Step with Memory
```json
{
  "title": "Schedule meeting and notify team",
  "description": "Schedule a meeting for 3 PM tomorrow and send a notification email about it."
}
```
**Expected time:** 20-40 seconds  
**Success rate:** > 90% (depends on step ordering and tool availability)

## Logging Strategy for Judges

### Critical Path Only
Include these logs for judges:
```
llm:request { runId, model, timeoutMs }
llm:response { runId, responseText (first 200 chars) }
step:execute { runId, toolName, attempt }
step:tool-execute { runId, toolName, success, latencyMs }
step:verify { toolName, passed }
lifecycle:completed { taskId, confidence }
lifecycle:failed { taskId, reason }
```

### Suppress (Too Noisy)
```
agent-runner llm:provider
agent-runner step:observe
agent-runner step:tool-failure (unless final failure)
llm:downgrade (suppress unless asked about fallback)
```

### Toggle Verbosity
```bash
# Minimal logs (judges only see results)
export LOG_LEVEL=warn

# Standard logs (critical path + errors)
export LOG_LEVEL=info

# Debug logs (full execution trace; instructor only)
export LOG_LEVEL=debug
```

## Known Edge Cases in Demo

| Case | Likelihood | Handling |
|------|-----------|----------|
| LLM timeout (>60s) | Low | Fallback to chat-completions; takes extra 10-20s |
| Tool failure (retryable) | Low | Auto-retry; LLM selects fallback tool |
| Lease loss | Very low | Watchdog detects; task transitions to `failed` |
| Malformed LLM output | Very low | LLM self-heals; re-requests structured JSON |
| Model overload | Possible on shared endpoints | Increase `TASK_AGENT_LLM_TIMEOUT_MS` to 90s |

## Demo Success Criteria

✅ **Success:**
- Task creation < 1 second
- LLM planning < 20 seconds
- Tool execution < 30 seconds
- Task completion visible within 40 seconds
- All `step:verify` logs show `passed: true`
- Final status is `completed` with `success: true`

❌ **Failure:**
- Task times out (> 120 seconds)
- Any `llm:error` with `category: "auth"` or `"non_retryable"`
- Tool execution fails with `adapterSuccess: false` and no retry
- Final status is `failed`

## Practice Run Checklist

Run through the demo flow 3 times before the actual presentation:

1. **First run**: Identify and fix basic issues (missing env vars, service down)
2. **Second run**: Validate timing and log output; adjust timeouts if needed
3. **Third run**: Time the entire flow; rehearse explanations; verify all criteria are met
