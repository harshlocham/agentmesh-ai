# Task Worker Execution Flow

## Purpose

The `apps/task-worker` process is the autonomous execution engine for tasks
derived from chat messages. It does three things:

1. Drains the MongoDB outbox produced by the web app (`message.created`,
   `task.execution.requested`, `task.execution.approved`,
   `task.created`, `task.updated`).
2. Runs an agent loop that plans, calls LLMs, executes tools, verifies
   outcomes, and persists execution state.
3. Bridges execution updates back to clients through the socket server's
   internal HTTP endpoints.

This document describes the control flow, persistence boundaries, and
operational properties. State-machine details live in
[ADR-001](../decisions/ADR-001-task-lifecycle-state-machine.md); retry
mechanics live in
[ADR-002](../decisions/ADR-002-retry-orchestration-strategy.md).

## Responsibilities

- Outbox claim / ack / DLQ (`apps/task-worker/index.ts:1602-1656`,
  `packages/services/outbox.service.ts`).
- Event routing for the four supported topics
  (`processOneEvent` in `apps/task-worker/index.ts:1479-1600`).
- Per-task lease coordination with heartbeat
  (`apps/task-worker/services/lease.service.ts`,
  `apps/task-worker/services/task-lease.ts`).
- Policy evaluation, idempotency guards, and human-approval flow
  (`apps/task-worker/services/execution-policy.ts`,
  `apps/task-worker/index.ts:1176-1460`).
- Plan generation and step execution
  (`apps/task-worker/services/planner.ts`,
  `apps/task-worker/services/agent-runner.ts`).
- Tool execution against external systems (Resend, GitHub, generic webhook).
- Execution event persistence and emission to the socket bridge
  (`apps/task-worker/services/execution-event.service.ts`,
  `packages/services/execution-event.service.ts`).
- Reflection / memory writeback after terminal runs
  (`apps/task-worker/services/reflection-service.ts`,
  `apps/task-worker/services/memory-service.ts`).
- Background sweepers for stuck tasks and scheduled retries
  (`stuck-task-detector.ts`, `retry-scheduler.ts`).

## Key Components

| Component | File | Role |
|---|---|---|
| Outbox loop | `apps/task-worker/index.ts:1602-1656` | Claims and processes outbox events. |
| Event router | `apps/task-worker/index.ts:1479-1600` | Dispatches to topic-specific handlers. |
| Lease service | `apps/task-worker/services/lease.service.ts` | `withExecutionLease` wraps a run with mutex + heartbeat. |
| `RetryManager` | `apps/task-worker/services/retry-manager.ts` | In-process bounded retry with backoff schedule. |
| `evaluateExecutionPolicy` | `apps/task-worker/services/execution-policy.ts` | Domain checks and approval gating. |
| `AgentRunner` | `apps/task-worker/services/agent-runner.ts` | The cross-iteration agent loop. |
| `ToolRegistry` | `apps/task-worker/services/tools/tool-registry.ts` | Tool registration and lookup. |
| LLM provider | `apps/task-worker/services/llm/*` | Provider abstraction over OpenAI-compatible and HuggingFace endpoints. |
| Planner | `apps/task-worker/services/planner.ts` | LLM-backed plan generation with deterministic fallback. |
| Reflection / Memory | `apps/task-worker/services/reflection-service.ts`, `memory-service.ts` | Post-run learning persisted in `TaskReflection` and `TaskMemory`. |
| Retry scanner | `apps/task-worker/services/retry-scheduler.ts` | Periodic promotion of `retry_scheduled` tasks back to `ready`. |
| Stuck detector | `apps/task-worker/services/stuck-task-detector.ts` | Logs tasks whose heartbeat is older than 5 minutes. |
| Shadow FSM | `apps/task-worker/services/execution-state-shadow.ts`, `execution-state-machine.ts` | Pure state reducer persisted alongside legacy fields. |

## Execution Modes

The worker runs the agent loop in one of two modes, selected by
`TASK_AGENT_PERSISTENT_LOOP_ENABLED`:

1. **Default (legacy step plan)** — `AgentRunner.runTask` walks a fixed
   3-stage plan (`validate-request`, `load-task-and-transition`,
   `execute-action-adapter`, `verify-execution-result`,
   `finalize-task-status`) using `RetryManager` for inline retries
   (`apps/task-worker/index.ts:968-1170`). This path exists for backward
   compatibility and does not use the plan/memory/reflection subsystem.
2. **Persistent step-based runner** —
   `AgentRunner.runTaskPersistent` (`agent-runner.ts:2015-2653`) loads a
   persisted `TaskPlan`, picks the next runnable step honoring
   `dependencies` and `fallbackPolicy`, retrieves short/long-term memory,
   ranks tools, asks an LLM for the next decision, optionally self-heals on
   first failure, executes, verifies, and either advances or retries.

Both modes share lease acquisition, idempotency guards, execution-event
emission, FSM shadowing, and reflection writeback. The persistent mode is
where tools are run through the registry; the legacy mode dispatches
directly to inline `executeXxxAction` adapters in `apps/task-worker/index.ts`.

## End-to-End Data Flow

```
[Web/API] ──insert──▶ OutboxEvent { topic, payload, dedupeKey, status: pending }
                                │
                                ▼
[task-worker loop] claimOutboxEvents(workerId, BATCH_SIZE)
   │
   ├── topic = "message.created"
   │     └─ processMessageTaskIntelligence
   │            └─ may create/update Task, emits internal bridge calls:
   │                 - /internal/message-semantic-updated
   │                 - /internal/task-created or /internal/task-updated
   │                 - /internal/task-linked-to-message
   │
   ├── topic = "task.execution.requested"
   │     └─ processTaskExecutionRequested
   │           ├─ evaluateExecutionPolicy(payload) → {auto_execute|approval_required|blocked}
   │           ├─ if blocked      → write failed result, emit "blocked"
   │           ├─ if approval req → createTaskAction(approval_pending), emit "approval_pending"
   │           └─ if auto_execute → withExecutionLease(taskId, workerId, fn)
   │                  └─ AgentRunner.runTask | runTaskPersistent
   │                        └─ emits "running" → tool exec → "succeeded"|"failed"
   │
   ├── topic = "task.execution.approved"
   │     └─ processTaskExecutionApproved
   │           └─ updateTaskActionExecutionState(approved)
   │             └─ processTaskExecutionRequested(normalized with confidence≥0.7)
   │
   └── topic = "task.created" | "task.updated"   (socket bridge passthrough)
         └─ emitInternal(socketPath, conversationId, socketPayload)
```

Every emit hits `/internal/*` on the socket server with the shared
`x-internal-secret` header (see ADR-003) and is fanned out to
`conversation:${conversationId}` rooms by `emitToConversation`
(`apps/socket/server/socket/emit.ts`).

## Outbox Loop Detail

`apps/task-worker/index.ts:1602-1656`:

1. `claimOutboxEvents(workerId, BATCH_SIZE = 10)` does up to 10 atomic
   `findOneAndUpdate` calls. Each picks the oldest row whose
   `status ∈ {pending, failed}` AND `availableAt <= now`, OR whose
   `status = processing` AND `lockedAt <= now - 5min`. Atomically:
   `$set { status: "processing", lockedBy, lockedAt }` and
   `$inc { attempts: 1 }`. The increment is **eager**: an event is counted
   as attempted at the moment it is claimed, before any handler runs.
2. For each claimed event, `processOneEvent` runs.
3. On success → `markOutboxEventCompleted`.
4. On thrown error → if `attempts >= OUTBOX_MAX_ATTEMPTS=12` →
   `markOutboxEventDeadLetter`, else
   `markOutboxEventFailed(id, message, computeRetryDelay(attempts))`.
5. The loop sleeps `POLL_INTERVAL_MS=800` ms when no events are claimed.

The eager increment means a worker that successfully processes an event still
sees `attempts >= 1`. Callers using `event.attempts` for branching must
account for this.

## Per-Event Idempotency

Inside `processOneEvent`:

```ts
const processedKey = `task-worker:processed:${event.dedupeKey}`;
const acquired = await redis.set(processedKey, WORKER_ID, "EX", 7 * 24 * 60 * 60, "NX");
if (!acquired) {
    await complete(eventId);
    return;
}
```

If Redis is unreachable (`redis === null`), this check is skipped and the
event is processed unconditionally. On any thrown error from the handler, the
Redis key is deleted so the next attempt can re-run. The `7d` TTL is the
practical de-dup window for cross-worker retries of the same `dedupeKey`.

## Lease Coordination

`withExecutionLease(args, fn)` in
`apps/task-worker/services/lease.service.ts:97-152` is the **only** sanctioned
way to enter the autonomous run. It:

1. Calls `acquireExecutionLease` which atomically claims `Task.leaseOwner` if
   the lease is null, expired, or already owned by the same worker. The
   acquisition writes `leaseExpiresAt = now + leaseMs` (default
   `TASK_LEASE_MS = 30 s`), `lastHeartbeatAt`, `executionRunId`,
   `executionStartedAt`, and resets `executionEventSequence = 0`.
2. Returns `{ skipped: "lease_busy" }` if the lease cannot be acquired.
3. Starts a `setInterval` heartbeat every `leaseMs / 3` (10 s default) that
   calls `heartbeatTaskLease`. If the heartbeat fails or returns null
   (lease lost), an `AbortController` is aborted; the abort signal is
   threaded into the runner.
4. On return, throws `LEASE_HEARTBEAT_LOST` if any heartbeat failed during
   the run.
5. Always releases the lease in `finally`.

Inside `AgentRunner.runTaskPersistent`, a second watchdog is started when
`ctx.leaseHeld` is false (`agent-runner.ts:2655-2701`). Whenever the
heartbeat fails, the watchdog aborts the in-flight iteration via an
`AbortController` whose signal is composed with the per-iteration
`AbortController` via `combineAbortSignals` (which prefers the native
`AbortSignal.any` when available). This is what makes the inner LLM call and
tool fetch terminate when the lease is lost.

## Tool Execution

Tools are registered against `ToolRegistry`
(`apps/task-worker/services/tools/tool-registry.ts`). Each tool implements:

```ts
interface Tool {
    name: string;
    description: string;
    inputSchema: z.ZodType<Record<string, unknown>>;
    execute(input, context): Promise<ToolResult>;
}
```

Three tools ship in the registry by default:

- `send_email` (`tools/send-email.tool.ts`): POSTs to Resend with the
  idempotency key as the upstream header.
- `schedule_meeting` (`tools/schedule-meeting.tool.ts`): generic webhook.
- `create_github_issue` (`tools/create-issue.tool.ts`): POSTs to the GitHub
  REST API.

`AgentRunner.execute(payload, options)` (`agent-runner.ts:2844-2994`) is the
sole entry point that runs a tool:

1. `guardIdempotentToolExecution(payload)` — see ADR-002 §2 for the unique
   `TaskAction.idempotencyKey` semantics. Returns cached success or marks the
   in-flight TaskAction.
2. Looks up the tool; returns a structured failure if missing.
3. `resolveToolParameters` (`apps/task-worker/services/resolve-tool-params.ts`)
   handles email recipient resolution, clarification escalation, and contact
   lookups. May return `clarification_required` which short-circuits the run.
4. Validates input via `tool.inputSchema.parse(...)` (throws `ZodError` on
   shape mismatch, classified as `validation` retry-permanent).
5. Builds an `AbortSignal` from `currentExecutionSignal` ∪ tool timeout
   (`TASK_AGENT_TOOL_TIMEOUT_MS=60s`).
6. Calls `tool.execute(parsedInput, context)`.
7. `finalizeIdempotentToolExecution` updates the TaskAction row with the
   final state (`succeeded`/`failed`).
8. Returns a `ToolResult` with a structured `evidence` envelope including
   `toolName`, `metadata.runId`, `metadata.stepId`, `metadata.attempt`,
   `metadata.idempotencyKey`.

## Verification

`AgentRunner.verify(result, context)` (`agent-runner.ts:2996-3015`) delegates
to `TaskSuccessRegistry.validate(actionType, task, result)`
(`apps/task-worker/services/task-success-registry.ts`). Each validator
inspects `result.evidence` and returns a `TaskValidationLog` with named
checks. Built-in validators:

- `EmailSuccessValidator`: requires a non-empty provider `messageId` and the
  absence of bounce markers.
- `MeetingSuccessValidator`: requires `eventId`/`meetingId`/`id` and
  participants-added marker.
- `GithubIssueSuccessValidator`: requires a non-empty `issue.html_url`.

The default fallback validator simply mirrors `adapterSuccess`. The confidence
score returned by `verify` is `passedChecks / totalChecks`, falling back to
`passed ? 1 : 0` when there are no checks. The validation log is appended to
`Task.executionHistory.results` (`appendCheckpoint` with `historyDelta`).

## LLM Provider Abstraction

`apps/task-worker/services/llm/`:

- `BaseLLMProvider` (abstract): defines
  `generate`, `healthCheck`, capability flags
  (`supportsResponsesApi`, `supportsStructuredOutputs`, `supportsToolCalling`,
  `supportsStreaming`, `supportsJsonMode`), metric recording.
- `OpenAIProvider`: implements the OpenAI/OpenAI-compatible Responses API.
  Used for `openai`, `openai-compatible`, `amd-openai-compatible`.
- `HuggingFaceProvider`: implements the HF Inference API. May also operate in
  OpenAI-compatible mode when `HUGGINGFACE_BASE_URL` ends with `/v1`.
- `provider-factory.ts`: reads `LLM_PROVIDER`, applies provider-specific
  capability overrides, exposes
  `createDefaultLLMProvider`, `validateProviderStartup`, and
  `recommendProviderForTaskProfile`.

`AgentRunner.requestLlmResponse(model, input)` is the only call site in the
runner. A test seam `options.llmRequestFn` lets tests inject deterministic
responses without going through the provider factory. Failures are wrapped as
`LLM_ERROR: ...` and classified as `transient_llm` by the retry classifier.

## Execution Event Stream

Every emission of `TaskExecutionUpdatedPayload` flows through the closure
captured by `AgentRunner`'s `onExecutionUpdate` (set by the main worker to
`emitTaskExecutionUpdate`). Before the payload is shipped to the socket
server, it is persisted:

`persistExecutionUpdatePayload(payload)` in
`packages/services/execution-event.service.ts:108`:

1. `allocateSequence(taskId, runId)` does `$inc { executionEventSequence: 1 }`
   on the task document, ensuring monotonic per-task sequence numbers.
2. `TaskExecutionEvent.create({ taskId, runId, sequence, type, phase, payload, createdAt })`.
3. Caller substitutes `sequence` back into the payload before HTTP emit.

`mapPayloadStateToEventType` (`execution-event.service.ts:77-106`) maps the
loose `(state, step)` combinatorics into a stable
`TaskExecutionEventType` enum (`tool_started`, `verification`,
`execution_completed`, `retry_scheduled`, etc.). Consumers can later read the
event stream via `getExecutionEventsAfter({ taskId, afterSequence, runId })`,
which is the basis for replaying or streaming a run history.

## Plan Execution (Persistent Mode)

`runTaskPersistent` (`agent-runner.ts:2015-2653`) is a single while loop
bounded by `TASK_AGENT_MAX_ITERATIONS` (default 8 in persistent mode). Each
iteration:

1. Heartbeat the lease.
2. Reload the latest task document.
3. `ensurePlan(task)` — load `TaskPlan` for this task; if missing, transition
   to `planning`, call `createOrRefreshTaskPlanFn` (which asks the LLM and
   falls back to a deterministic 3-step plan if parsing fails), and return to
   `ready`.
4. `pickNextRunnableStep(plan)` — choose the lowest-`order` step in `ready`
   or `retry_scheduled` whose dependencies are completed (or
   completed/failed/skipped when `fallbackPolicy: "immediate_execution"`).
5. If no runnable step exists, decide between three terminal cases:
   - Any step `failed`/`blocked` → transition to `failed`.
   - No pending steps → emit `GOAL_ACHIEVED`, transition to `completed`.
   - Pending but unrunnable (cyclic block) → transition to `blocked` with a
     reason.
6. Mark step `running`, update `currentStepId` and `iterationCount`.
7. `retrieveMemory({ taskId, conversationId, toolName, limit: 10 })` returns
   `{ shortTerm, longTerm }` rows from `TaskMemory`.
8. `rankStepTools(step, longTerm)` — combine planner-supplied
   `toolCandidates` with historical success rates from long-term memory to
   compute a ranking via
   `apps/task-worker/services/tool-ranking.ts:rankTools`.
9. `decideStepAction({...})` — call the LLM with system prompt requesting a
   JSON object with `{ tool, confidence, parameters, reasoning,
   needsClarification, clarificationQuestion }`. Validated via
   `llmDecisionSchema` (`step-execution-utils.ts`). If the LLM returns a
   tool not in the ranked list, the decision is rejected with `LLM_ERROR`.
10. If `needsClarification` (including low-confidence
    auto-classification < `TASK_AGENT_CONFIDENCE_THRESHOLD=0.7`) → mark step
    `blocked`, pause task, return.
11. Validate parameters via `validateToolParameters(tool, normalized)`.
    On failure with budget remaining → `scheduleTaskRetry` and return; on
    budget exhausted → fail.
12. **First execution attempt** with the original decision parameters.
13. If the first attempt fails and `step.attempts < step.maxAttempts`, the
    runner does **one self-heal attempt**: it calls the LLM again with the
    failure context as `previousError` + `previousParameters`. If the new
    decision validates and is different, the runner re-executes once. Any
    further failure goes to the verification path.
14. `observe(...)` records the result; `verify(...)` produces a
    `VerificationOutcome`.
15. On success → mark step `completed`. If all steps are completed,
    `GOAL_ACHIEVED`, transition to `completed`, set
    `Task.result = { success: true, ... }`, break.
16. On failure with budget remaining → mark step `retry_scheduled`, call
    `scheduleTaskRetry`, return. Otherwise → mark step `failed`, transition
    to `failed`, break.
17. Per-iteration timeout: `TASK_AGENT_ITERATION_TIMEOUT_MS=120s` aborts the
    iteration's composite signal.

After the loop, `generateAndStoreReflection({ outcome, executionSummary,
toolName })` writes a `TaskReflection` row and writes both short- and
long-term memory entries from the structured `whatWorked`/`whatFailed`/
`improvements` produced by the reflection LLM (with a deterministic fallback
if the LLM fails to return JSON).

## Tradeoffs

- **Two parallel code paths**: the legacy 3-step plan and the persistent step
  runner. The agent runner constructor itself works both ways, but the
  policy/lease shell in `processTaskExecutionRequested` always runs
  `agentRunner.runTask(...)`. Whether that delegates to the persistent path
  depends on a single env flag. This was an explicit migration choice but
  doubles the surface area for bugs.
- **Per-write Mongoose round-trip**. `appendCheckpoint`, `emitExecutionUpdate`,
  `updateTask`, `persistShadowExecutionState`, and `allocateSequence` each
  write the task document or a related collection. A "happy path" iteration
  produces ~10 DB round-trips. The benefit is full audit; the cost is write
  amplification.
- **No streaming LLM**. `requestLlmResponse` waits for the full response.
  This keeps the JSON-decision schema simple but inflates worst-case
  latency. The capability flag exists on the provider but is not used by the
  runner.
- **No execution-state side-effect coupling**. The legacy lifecycle and the
  FSM are written separately. Crash between the two leaves the FSM stale; the
  legacy is the source of truth. See ADR-001 §2.

## Failure Handling

The combination of layered failure handling means most failures are
**bounded**:

- **Process crash mid-iteration**: the lease expires; either the retry
  scanner promotes the task on `nextRetryAt` (if `scheduleTaskRetry` ran
  before the crash) or the original `task.execution.requested` outbox row is
  re-claimed (it stays `processing` until the 5-minute stale cutoff). The
  next worker either steals the lease and continues, or sees the lease still
  held and bails with `lease_busy`.
- **External API throwing**: bubbled up as `Error`, classified by
  `retry-classifier.ts`, and routed through `scheduleTaskRetry`.
- **LLM returns garbage**: `parseJsonText` + `llmDecisionSchema.safeParse`
  reject; `LLM_ERROR:` thrown; `scheduleTaskRetry` defers re-execution.
- **Tool times out**: `AbortController` fires; tool function rejects with
  abort/timeout; classifier returns `tool_timeout`.
- **Lease lost during run**: heartbeat fails → abort signal → tool's
  `signal.aborted` triggers a `Tool failed: ` summary but the outer scope
  detects `/abort|timed out|lease lost/i.test(reason)` in
  `agent-runner.ts:1575` and exits the run cleanly without burning a retry
  attempt.

## Scalability Considerations

- The outbox is the central queue. Horizontal scaling is "add more
  workers." Each worker has an independent ID (`pid-randsuffix`) and
  independent lease handles. There is no leader; all coordination is in
  MongoDB and Redis.
- The retry scanner is per-worker. With N workers, the cluster runs N
  scanners that each claim one row per 5 s tick. They contend on the same
  `findOneAndUpdate` so the effective claim rate is one per 5 s globally on
  the same row, but N rows can be claimed across N workers in the same tick.
- LLM concurrency is bounded by the number of in-flight tasks per worker.
  There is no explicit semaphore. Memory pressure scales linearly with task
  count.
- MongoDB writes per task per iteration are high. At scale, the right
  primitive is per-event upsert into `TaskExecutionEvent` (already in place)
  and removing the in-document `executionHistory.results` array. The schema
  caps it at 100 entries by sliding window, but the document still rewrites
  on every change.

## Technical Debt / Limitations

1. The legacy retry helper `RetryManager` and the schedule-based retry path
   live side-by-side. Removing the inline path requires removing the
   `buildExecutionPlan` block in `apps/task-worker/index.ts` and migrating
   the email/meeting/github inline adapters to tools (already implemented in
   the tools/ directory).
2. `processMessageTaskIntelligence` in `task-intelligence.service.ts` uses
   regex-based classification (`classifyMessage`); this is intentionally
   pre-LLM, with `AI_VERSION = "intelligent-v3-preprocess"`. It under-fires
   for any task phrased without imperative verbs.
3. `executeXxxAction` (legacy) and the tool counterparts (registry) duplicate
   transport logic. A regression in one will not surface in the other.
4. `Task.iterationCount`, `step.attempts`, `Task.retryCount`,
   `OutboxEvent.attempts`, and `TaskAction.attempt` are five separate counters
   for retry-adjacent concepts. Operational dashboards must join all five.
5. Cancellation events are typed in the FSM but no caller emits them.
   "Cancel a running task" is an unimplemented operation.

## Future Evolution

- Promote the persistent step runner to the only path and remove the legacy
  `buildExecutionPlan`.
- Move execution events out of MongoDB into a dedicated append-only store
  (e.g. Redis Streams, Kafka, or a partitioned event table) so the
  `Task` document stops carrying the high-frequency write surface.
- Replace `processMessageTaskIntelligence`'s regex heuristics with an LLM
  call gated by `confidence` to avoid creating tasks for chit-chat.
- Wire cancellation through the outbox (`task.cancel.requested`) so a user
  click in the UI can stop a long-running run mid-flight.

## Uncertain

- The expected ratio of tasks needing approval vs auto-executing is not
  encoded in the policy; it depends on parameters and the
  `ALLOWED_EMAIL_DOMAINS` allowlist. Empirical numbers should be tracked in
  production logs.
- The persistent runner's "self-heal" attempt may interact with idempotency
  in surprising ways: if the corrected decision produces the same
  `idempotencyKey`, the cached failure is replayed. The runner relies on the
  corrected parameters typically changing — but this is not explicitly
  validated.
