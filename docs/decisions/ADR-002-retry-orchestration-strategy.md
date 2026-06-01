# ADR-002: Retry Orchestration Strategy

- Status: Accepted
- Scope: `apps/task-worker` (outbox loop, agent runner, retry scheduler/scanner,
  retry classifier, retry manager), `packages/services/outbox.service.ts`,
  `packages/db/models/Task.ts`
- Related: ADR-001 (Task lifecycle), `docs/architecture/task-worker-execution-flow.md`

## Context

The task-worker performs two qualitatively different kinds of retry:

1. **Outbox-level retries**: failures of `processOneEvent` in
   `apps/task-worker/index.ts` (e.g. payload validation, unhandled exceptions).
   These must not duplicate side effects and must eventually dead-letter.
2. **Task-level retries**: failures of an action adapter, a tool call, an LLM
   call, or verification. These need classification (transient vs permanent),
   per-attempt backoff, and a way to re-enqueue the same task after a delay
   without holding a worker.

A third, much shorter-lived retry is the **inline action retry** inside
`RetryManager.execute`, used by the legacy step-based plan in
`apps/task-worker/index.ts:1011-1063` and by miscellaneous tool calls inside
`AgentRunner` that want bounded inline retry.

ADR-002 documents how these three layers compose, what guarantees each layer
provides, and how idempotency is enforced.

## Decision

### 1. Outbox is the integration boundary

The web layer enqueues domain events (`message.created`, `task.execution.requested`,
`task.execution.approved`, `task.created`, `task.updated`) into
`OutboxEvent` (`packages/db/models/OutboxEvent.ts`). The worker loop
(`apps/task-worker/index.ts:1602-1656`) repeatedly:

1. `claimOutboxEvents(workerId, BATCH_SIZE)` — atomic
   `findOneAndUpdate` with `$set { status: "processing", lockedBy, lockedAt }`
   and `$inc { attempts: 1 }`, ordered by `createdAt`
   (`packages/services/outbox.service.ts:28-68`).
2. Calls `processOneEvent(event)` per claim.
3. On success: `markOutboxEventCompleted` clears all lock fields.
4. On failure:
   - If `event.attempts >= OUTBOX_MAX_ATTEMPTS` (default 12) →
     `markOutboxEventDeadLetter`.
   - Otherwise → `markOutboxEventFailed(id, message, computeRetryDelay(attempts))`
     which sets `status: "failed"` and `availableAt = now + delay`.
5. `computeRetryDelay(attempts)`:
   `min(MAX_BACKOFF_MS_LIKE, BASE * 2^min(attempts, 8))` plus
   `±OUTBOX_RETRY_JITTER_PCT` jitter, clamped to ≥250ms
   (`apps/task-worker/index.ts:285-295`). Base is 1000 ms; with `attempts=8` the
   raw delay caps at 256 s ± 20% jitter.

Stale `processing` rows older than 5 minutes are also re-claimable
(`outbox.service.ts:42-47`), giving cross-worker recovery without an explicit
heartbeat.

### 2. Per-event idempotency guards

The outbox is at-least-once. Idempotency is layered on top:

- **Per-event de-duplication**: `processOneEvent` derives a Redis key
  `task-worker:processed:${event.dedupeKey}` and tries
  `SET NX EX 7d` (`apps/task-worker/index.ts:1488-1499`). If the key already
  exists, the event is acknowledged without processing. On thrown error, the
  Redis key is deleted so the next claim can re-attempt.
- **Per-action idempotency** (legacy path):
  `buildActionIdempotencyKey(payload)` hashes
  `(taskId, actionType, stableStringify(parameters))` and `withIdempotencyGuard`
  enforces a Redis lock (`SET NX EX 60`) plus a done-cache
  (`SET EX 7d`) (`apps/task-worker/index.ts:412-487`). Concurrent workers
  observing the lock poll the done-cache for ~1 s and return a "duplicate
  skipped" result if not seen.
- **Per-tool idempotency** (agent-runner path):
  `AgentRunner.buildToolIdempotencyKey` is a SHA-256 of
  `taskId | runId | stepId | toolName | stableStringify(params)`
  (`agent-runner.ts:2737-2749`).
  `guardIdempotentToolExecution` queries `TaskActionModel` for an existing row
  with that `idempotencyKey`:
  - If found and `executionState === "succeeded"`: replay the cached
    `summary`/parameters as an idempotent success.
  - If found and still in-flight: short-circuit with
    `error: "duplicate_in_flight"`.
  - Otherwise: insert a `TaskAction` with `executionState: "running"` and the
    idempotency key. Mongoose unique-index conflicts (`code: 11000`) are
    handled by recursing back into `guardIdempotentToolExecution`.
- The Resend send-email tool also forwards the idempotency key as the upstream
  `Idempotency-Key` header (`apps/task-worker/services/tools/send-email.tool.ts:45`).

### 3. Task-level retry scheduling

When an agent run cannot succeed but the failure is retryable, the run does
**not** immediately retry. It schedules a future re-execution and releases the
worker:

`scheduleTaskRetry(task, error, { runId, actionType, emit })` in
`apps/task-worker/services/schedule-retry.ts`:

1. Classifies the error with `classifyExecutionError(error, currentRetry)`
   (`retry-classifier.ts`). Categories:
   - `transient_llm` — `LLM_ERROR:` prefix, "rate limit", "overloaded".
   - `tool_timeout` — abort/timeout/lease-heartbeat strings.
   - `network` — econnreset/refused/fetch-failed/socket-hang-up.
   - `validation` — non-retryable; "validation"/"invalid parameter"/"zod"/
     "parse"/"schema".
   - `permanent_tool_rejection` — non-retryable; rejected/forbidden/
     unauthorized/policy/4xx (except 429).
   - Default fallback: retryable, treated as `network`.
2. Backoff: `BASE_BACKOFF_MS * 2^attempt` capped at `MAX_BACKOFF_MS` with
   50–100% multiplicative jitter (`retry-classifier.ts:18-22`). Defaults: 2 s
   base, 5 min cap.
3. If non-retryable or `nextRetryCount > maxRetries` (default `maxRetries = 2`):
   set `lifecycleState: "failed"`, `status: "failed"`,
   `retryCount: nextRetryCount`, `lastRetryReason`, `lastRetryAt`. Emit a
   `failed` execution update.
4. Otherwise: set `lifecycleState: "retry_scheduled"`, `status: "partial"`,
   `nextRetryAt = now + decision.delayMs`, `retryCount: nextRetryCount`.
   Emit a `queued` execution update of phase `retry` with
   `step: "retry_scheduled"`.

This path is invoked from `AgentRunner` in three places (LLM decision failure,
parameter validation failure in the persistent runner, and verification
failure with budget remaining). After scheduling, the runner returns rather
than continuing the loop.

### 4. Retry scanner promotes scheduled tasks

`startRetryScheduler` runs an interval (`TASK_RETRY_SCAN_INTERVAL_MS`,
default 5 s) calling `runRetryScannerOnce` per tick
(`apps/task-worker/services/retry-scheduler.ts`):

1. `mongoose.startSession()` + `withTransaction`. Inside the transaction:
2. `findOneAndUpdate` an unleased `retry_scheduled` row whose
   `nextRetryAt <= now`, atomically flipping
   `lifecycleState: "ready"` and stamping `lastRetryAt: now`. Sorted by
   `nextRetryAt` to drain oldest-first.
3. `enqueueOutboxEvent("task.execution.requested")` with a deterministic
   `dedupeKey = "task.execution.requested:<taskId>:retry:<retryCount>"` —
   appends in the same transaction.
4. `createTaskAction({ executionState: "queued", ... })` with an idempotency
   key keyed on the retry count, so an accidental re-run scanner does not
   create a duplicate audit row (the `code: 11000` swallow path is explicit).

Because steps 2 + 3 + 4 sit inside one transaction, a partial failure rolls
back the lifecycle transition and the next scan retries. The task therefore
appears in the outbox **once per `retryCount` value**.

### 5. Inline retry inside RetryManager

`RetryManager.execute<T>(options)`
(`apps/task-worker/services/retry-manager.ts`) is a small abstraction used by
the legacy execution path:

- Tracks `attempt` and `retryCount` independently.
- Delegates retryability to `options.shouldRetry`.
- Calls `options.onRetry` between attempts with structured
  `{ attempt, retryCount, maxRetries, reason, delayMs, error }`.
- Delay schedule: positional table, default `[1000, 2000, 5000]`.

This is intentionally synchronous within a single worker process. It is **not**
suitable for cross-worker retry; it does not release the lease, does not write
`nextRetryAt`, and does not interact with the outbox. It is used only by the
old execution plan in `apps/task-worker/index.ts:968-1107` (the
`buildExecutionPlan` block) and to emit per-retry execution updates.

## Layered guarantees

```
Outbox loop                  at-least-once + dedupeKey (Redis) + 12 attempts → DLQ
  └─ withExecutionLease      mutual exclusion per task (DB lease + 1/3 leaseMs heartbeat)
       └─ AgentRunner        in-process iteration loop (max iterations, lease watchdog)
            ├─ scheduleTaskRetry   long-term retry: writes nextRetryAt and returns
            ├─ guardIdempotentToolExecution   per-tool one-shot via TaskAction unique index
            └─ RetryManager.execute            short-term in-process retry (legacy path only)
```

The composition has one important asymmetry: `scheduleTaskRetry` increments
`Task.retryCount`, but `Task.maxRetries` defaults to 2. Combined with the
per-attempt backoff cap of 5 min, the effective wall-clock budget for a task
is roughly 10 minutes before it terminates as `failed`. Operators should set
`maxRetries` per task type if they need a different policy; the schema accepts
any non-negative integer.

## Failure Handling

| Layer | Failure | Behavior |
|---|---|---|
| Outbox claim | Worker crashes after `findOneAndUpdate` | Row remains `processing`; reclaim after `stale_processing_cutoff = 5 min`. |
| Outbox process | `processOneEvent` throws | `markOutboxEventFailed` with exponential delay; after `OUTBOX_MAX_ATTEMPTS=12` → dead-letter. |
| Outbox dedupe | Redis unavailable | `if (!redis) shouldProcess = true`; the worker proceeds without de-dup. This is documented in code at `apps/task-worker/index.ts:1490-1494`. |
| Lease | Heartbeat lost | `withExecutionLease`'s `setInterval` aborts the AbortController; the runner sees the signal and throws `Execution aborted.`; the outbox path records the failure and re-enqueues. |
| Lease | Steal by another worker | `acquireTaskLease`'s `$or` includes `{ leaseExpiresAt: { $lt: now } }` so any worker can take over after expiry; the original `release` call is then a no-op due to the `leaseOwner` predicate. |
| Tool execution | Adapter returns non-2xx | Tool result has `adapterSuccess: false`; agent-runner records the failure in `executionHistory`, calls `scheduleTaskRetry` if budget remains, else marks failed. |
| LLM failure | Provider throws | `decideNextAction` rethrows as `LLM_ERROR: …`; classifier returns `transient_llm`; `scheduleTaskRetry` defers re-execution. |
| Verification failure | `verify()` returns `success=false` | Counts as a retry; budget governed by `step.maxAttempts ?? 3` in persistent runner and by `Task.maxRetries` overall. |
| Duplicate side effect | Two workers race on the same step | `guardIdempotentToolExecution` rejects the second via the unique `idempotencyKey` index; the runner returns the cached summary if previously succeeded. |

## Tradeoffs

- **At-least-once vs duplicate side effects**. The outbox is at-least-once and
  the worker bridge to the socket server is also at-least-once. Idempotency is
  enforced at three layers (event dedupe, action dedupe, tool dedupe), but
  this only works for tools/actions whose effects are keyed by parameters. For
  tools whose effects depend on time or non-deterministic content (e.g.
  generated email body), the idempotency key derived from parameters is
  insufficient and will re-execute on parameter change.
- **Backoff is bounded but not adaptive**. The classifier uses fixed envelope
  values from env vars; there is no provider-specific backoff (e.g. honoring
  `Retry-After`) and no circuit-breaker.
- **Retry scanner is single-flight per tick**. `runRetryScannerOnce` claims
  one row per call. The scheduler ticks every 5 s, so the maximum
  retry-promotion throughput is one task per 5 s per worker. This is fine for
  current scale but is an explicit ceiling.
- **Layered counters are independent**. `OutboxEvent.attempts`, `Task.retryCount`,
  `TaskAction.attempt`, and `step.attempts` each have their own life cycle.
  Reasoning about "how many times did we try this" requires joining all four.

## Scalability Considerations

- Multiple workers safely share an outbox. The atomic `findOneAndUpdate` is
  the only serialization point and benefits from
  `OutboxEvent` indexes on `status` and `availableAt` (assumed; the model file
  is in `packages/db/models/OutboxEvent.ts` and is referenced by both the
  outbox service and the scanner).
- The lease is held in the `Task` document, indexed by
  `{ leaseOwner: 1, leaseExpiresAt: 1 }` and partially indexed for run-owned
  executions via `executionState.kind`. Lease acquisition is O(1) per task.
- The retry scanner's `withTransaction` requires a replica-set MongoDB; the
  worker assumes this without checking. A single-node MongoDB will return
  `Transaction numbers are only allowed on a replica set member or mongos` and
  the scanner will fail every 5 s.
- `Redis` is optional but recommended. Without it, event-level deduplication
  degrades to "the outbox does not double-deliver inside `attempts <
  OUTBOX_MAX_ATTEMPTS`", which is materially weaker.

## Technical Debt / Limitations

1. The legacy `buildExecutionPlan` path in `apps/task-worker/index.ts` and the
   new `AgentRunner` path both exist. They have **different retry semantics**:
   the legacy path uses `RetryManager` inline; the new path schedules retries
   via `scheduleTaskRetry`. Whether a given execution takes the new path is
   controlled by `TASK_AGENT_PERSISTENT_LOOP_ENABLED`. The two paths' retry
   budgets are not unified.
2. `RetryManager`'s default schedule `[1000, 2000, 5000]` is hard-coded in
   multiple places (`apps/task-worker/index.ts:70`,
   `apps/task-worker/services/agent-runner.ts:376`,
   `apps/task-worker/services/agent-runner.ts:3073-3076`).
3. The dedupe key for retry outbox events
   (`task.execution.requested:<taskId>:retry:<retryCount>`) means concurrent
   scanners on the same task at the same `retryCount` see a unique-index
   collision on `OutboxEvent.dedupeKey` (assumed unique; verify in
   `OutboxEvent.ts`). If the index is **not** unique, two retries can land in
   the outbox.
4. The classifier never sees HTTP `Retry-After` or provider-specific signals;
   for example, a Resend 429 with a 10-minute `Retry-After` would still be
   retried in roughly 2 minutes.
5. There is no cap on the cumulative `executionHistory.results` size on the
   task document beyond `trimExecutionResults(cap=100)` in `agent-runner.ts`,
   which slides the window silently.

## Future Evolution

- Pull the backoff schedule and retry budgets into a typed `RetryPolicy`
  passed per task type (email, github_issue, meeting). Today there is one
  policy for all action types.
- Honor `Retry-After` / `X-RateLimit-Reset` from upstream APIs in the
  classifier.
- Move event de-duplication from Redis-key TTL to a MongoDB index on
  `OutboxEvent.dedupeKey` + status compound index, so de-dup survives Redis
  loss.
- Surface a per-task retry timeline in the UI by joining `Task.checkpoints`,
  `TaskExecutionEvent` (sequence-ordered), and the FSM `stateHistory`. The
  data is there; the UI is not.

## Uncertain

- The exact `OutboxEvent` index set is not inspected in this ADR; some claims
  about deduplication depend on `dedupeKey` being uniquely indexed.
  Confirm by inspecting `packages/db/models/OutboxEvent.ts`.
- The interaction between
  `TASK_AGENT_PERSISTENT_LOOP_ENABLED=true` and the legacy `RetryManager`
  calls inside `processTaskExecutionRequested` is not fully exercised by the
  default config; the legacy path is the default. Whether the new path is
  production-ready is a runtime question rather than a code question.
