# ADR-001: Task Lifecycle State Machine

- Status: Accepted (implemented, partially in shadow mode)
- Scope: `apps/task-worker`, `packages/db/models/Task.ts`, `packages/types/task/execution-state.ts`
- Related: ADR-002 (Retry orchestration), `docs/architecture/task-worker-execution-flow.md`

## Context

A single `Task` record represents an autonomous unit of work originated from a chat
message and persisted in MongoDB. Multiple workers can pull execution events from
the outbox; each task may require planning, tool execution, verification, retries,
human approval, and clarification before it terminates.

The repository operates **two coexisting state models** on the same `Task` document:

1. A coarse **legacy lifecycle** (`Task.lifecycleState` + `Task.status`) used by
   the database indexes, the retry scanner, and most UI surfaces.
2. A fine-grained **execution FSM** (`Task.executionState` + `Task.stateHistory`)
   currently persisted in shadow mode behind
   `TASK_EXECUTION_FSM_SHADOW_MODE !== "0"`.

ADR-001 captures the rationale, edge contract, and operational semantics of both
state models and how they coexist.

## Decision

### 1. Two state surfaces, one source of truth document

`Task.lifecycleState` (defined in `packages/db/models/Task.ts:106-131`) is the
**authoritative** field today. All MongoDB indexes that drive scheduling, lease
sweeping, and retry recovery (`lifecycleState: 1, leaseExpiresAt: 1`,
`lifecycleState: 1, nextRetryAt: 1`) target this field. The schema enum is:

```
planning, ready, executing, waiting_for_approval, blocked,
retry_scheduled, paused, completed, failed
```

The legal transitions live in
`apps/task-worker/services/task-state-machine.ts:18-28` and are enforced by
`assertTransition`, which throws on illegal edges. Notably:

- `completed` and `failed` are absorbing states (`[]` transitions out).
- `retry_scheduled` may transition back to `ready` or directly to `executing`,
  used by `runRetryScannerOnce` to atomically promote a row before enqueuing the
  outbox event.

### 2. Shadow execution FSM

`packages/types/task/execution-state.ts` defines a discriminated-union
`ExecutionState` over 18 kinds plus an `ExecutionEvent` algebra of 17 event
types. `apps/task-worker/services/execution-state-machine.ts` implements:

- `LEGAL_EXECUTION_TRANSITIONS` (lines 16-84): the explicit graph of legal
  `(from, to)` edges.
- `reduceExecutionState(state, event)`: a pure reducer. Each event clause
  validates the source state, constructs the next state (re-using run-owned
  fields such as `runId`, `workerId`, `leaseExpiresAt`, `iteration`), and calls
  `assertExecutionTransition`. Illegal events throw
  `InvalidExecutionTransitionError` and the caller must handle it.

The FSM is invoked exclusively through `execution-state-shadow.ts`:

- `reduceShadowExecutionEvent` wraps `reduceExecutionState` in a try/catch and
  always returns a `ShadowTransitionResult` containing `historyEntry`, so an
  invalid transition is logged but never aborts the run.
- `appendShadowHistory` caps `Task.stateHistory` at `SHADOW_HISTORY_LIMIT = 100`
  entries (sliding window).
- `AgentRunner.persistShadowExecutionState`
  (`agent-runner.ts:821-860`) saves both `executionState` and `stateHistory`
  on each emission and emits a structured log
  (`execution.fsm_shadow.transition` / `execution.fsm_shadow.invalid_transition`)
  but does **not** propagate FSM errors to control flow.

This separation lets us iterate the FSM aggressively while the legacy lifecycle
remains the contract observed by indexes, sockets, and the web layer.

### 3. Run ownership and lease coupling

States in `RUN_OWNED_EXECUTION_STATES` (planning, ready_to_execute, reasoning,
tool_executing, observing, verifying, step_complete) carry
`{ runId, workerId, leaseExpiresAt }`. A run is therefore strongly bound to a
specific worker until either:

- a terminal state (`succeeded`, `failed`, `cancelled`) is reached, or
- the lease lapses and another worker steals it via
  `acquireTaskLease`/`acquireExecutionLease` (see ADR-002).

`shouldResetShadowRunState` collapses any prior terminal state back to `queued`
on the next run, ensuring that a re-enqueued retry begins a fresh FSM lineage
rather than mutating a closed state graph.

### 4. Legacy projection

`deriveLegacyLifecycleState(state)` and `deriveLegacyTaskStatus(state)` in
`packages/types/task/execution-state.ts:143-203` define a deterministic
projection from the new FSM into the legacy fields. This is documented for
future cutover but is **not invoked at write time** in the current code path:
`AgentRunner.updateTask` writes legacy fields directly and
`persistShadowExecutionState` writes FSM fields separately. The two paths are
not transactionally coupled, which is the central limitation called out in §6.

## Lifecycle in Practice

A canonical successful run, traced through `processTaskExecutionRequested`
(`apps/task-worker/index.ts:1176`) and
`AgentRunner.runTask` / `runTaskPersistent`:

```
queued
  → POLICY_EVALUATE              → policy_evaluating
  → POLICY_BLOCKED                → policy_blocked        (terminal-ish)
  → POLICY_APPROVAL_REQUIRED      → awaiting_approval
  → LEASE_ACQUIRED                → planning
  → PLAN_READY                    → ready_to_execute
  → ITERATION_START               → reasoning
  → TOOL_STARTED                  → tool_executing
  → TOOL_OBSERVED                 → observing
  → TOOL_VERIFIED                 → verifying
  → STEP_COMPLETED                → step_complete
  → ITERATION_START               → reasoning  (loop)
  ...
  → GOAL_ACHIEVED                 → succeeded
```

Branches:

- `CLARIFICATION_REQUIRED` → `paused` with a `pendingClarification` payload. A
  later `CLARIFICATION_RESOLVED` returns to `reasoning` carrying a new
  `iteration` counter.
- `ERROR_OCCURRED` with `retryable && retryCount <= maxRetries && nextRetryAt`
  → `retry_scheduled`. Otherwise → `failed`.
- `RETRY_DUE` → `queued` (the retry scanner is responsible for emitting this and
  enqueueing the outbox event in the same MongoDB transaction).
- `CANCEL_REQUESTED` / `CANCEL_FINALIZED` flow to `cancelling`/`cancelled`. The
  reducer accepts CANCEL_REQUESTED from almost any non-terminal state, but the
  current runtime has no observed callers emitting these events; cancellation is
  not yet wired into the agent runner.

## Tradeoffs

- **Two reducers, one document**. The legacy lifecycle and the FSM each have
  their own enum, transition table, and persistence path. This duplicates
  semantic information (e.g. `executing` exists in both, but maps to seven FSM
  states). Keeping them in lockstep is currently a programmer discipline, not a
  runtime invariant.
- **Optimistic concurrency on `Task`**. The schema enables
  `optimisticConcurrency` with a `version` key. `AgentRunner.updateTask` reads
  `version` before save, but `task.save()` on a mutated mongoose document does
  not guard against another worker incrementing `version` between fetch and
  save. The lease provides the cross-worker mutual exclusion that
  `optimisticConcurrency` does not.
- **Shadow FSM is best-effort**. Persistence failures (`persistShadowExecutionState`
  catch block) log and continue. Invalid transitions are recorded in
  `stateHistory.shadowError` and the FSM stays on `from`. This is intentional
  while the FSM is being validated against production traffic, but it means a
  divergent FSM cannot be trusted as the source of truth yet.
- **Single document hotspot**. All execution state, checkpoints, execution
  history (capped at 100), and state history (capped at 100) live on the same
  document. High-frequency emissions hit a single shard key with frequent
  mongoose `save()` calls. See §Scalability.

## Failure Handling

| Failure mode | Detection | Recovery |
|---|---|---|
| Worker crash mid-run | `Task.leaseExpiresAt < now` and `lifecycleState = executing` | `acquireTaskLease` and `acquireExecutionLease` predicate `{ leaseExpiresAt: { $lt: now } }` allow steal; `stuck-task-detector.ts` logs warnings on `lastHeartbeatAt < now - 5min`. |
| Illegal FSM transition | Caught in `reduceShadowExecutionEvent` | Logged as `execution.fsm_shadow.invalid_transition`, FSM stays on `from`, history records `shadowError`. |
| Legacy/FSM divergence | Not detected automatically | Compared manually via `stateHistory`. No reconciliation job exists. |
| Plan step fails irrecoverably | `runTaskPersistent` walks plan, sees `state === "failed"` and `hasPending = false` | Calls `transitionLifecycle(task, "failed")` and emits `ERROR_OCCURRED` with `retryable: false` and `category: "plan_step_failed"`. |
| Max iterations | Guarded by `TASK_AGENT_MAX_ITERATIONS` | Emits `ERROR_OCCURRED` with `category: "max_iterations"` and sets `lifecycleState: "failed"`. |

There is **no audit step** that periodically validates `Task.executionState`
against `Task.lifecycleState`. If they diverge, the legacy field wins implicitly
because every consumer (sockets, web API, outbox scanner) reads the legacy
field.

## Scalability Considerations

- The persistent runner saves the task document on every checkpoint, FSM
  transition, and `updateTask` change. A long iteration cycle can produce
  20–30 mongoose `save()` calls. With per-task write concentration this is
  acceptable for the current scale but becomes a bottleneck if tasks fan out.
- `stateHistory` and `checkpoints` are sliding windows on the same document;
  shrinking them is intentionally simple but discards forensic data.
- `Task.executionEventSequence` is incremented atomically in
  `allocateSequence` (`packages/services/execution-event.service.ts:10-22`),
  giving a monotonically increasing per-task sequence number for events
  appended to `TaskExecutionEvent`. This decouples the rich event log from the
  Task document but adds one extra round-trip per emission.

## Technical Debt / Limitations

- The FSM is **declared, exercised, and persisted**, but it is **not the
  enforcement boundary** for state changes. Every state transition is driven by
  `AgentRunner` invoking both `updateTask(...)` and `persistShadowExecutionState(...)`
  in close sequence. Removing this duplication would require:
  1. Promoting the FSM to the authoritative field.
  2. Migrating indexes and consumers to read `executionState.kind`.
  3. Rewriting `runRetryScannerOnce` and `acquireExecutionLease` to operate on
     `executionState.kind` and `executionState.nextRetryAt` (partial indexes
     for these already exist in the schema, lines 257-270).
- Cancellation is modeled in the FSM (`CANCEL_REQUESTED`, `CANCEL_FINALIZED`,
  `cancelling`, `cancelled`) but no caller emits these events; UI-driven
  cancellation is not implemented.
- `Task.iterationCount` is read in `runTaskPersistent` (line 2039) but the
  reset semantics after a clarification-resume are subtle: the FSM increments
  `iteration` while `Task.iterationCount` is updated by `updateTask` on each
  loop. They are independent counters today.
- The legacy `task-state-machine.ts` predates the new FSM and uses a different
  alphabet (e.g. `retry_scheduled` is shared, but the FSM has `ready_to_execute`
  vs the legacy `ready`). Some transitions allowed by the legacy table (e.g.
  `executing → completed`) are explicitly invalid in the FSM (`succeeded` is
  only reachable from `reasoning` or `step_complete`).

## Future Evolution

1. **Cutover plan**: promote `executionState` to authoritative. The partial
   indexes already exist; the missing pieces are (a) atomic write-coupling
   `executionState` + `lifecycleState`, (b) a dual-read/write phase, then
   (c) removing the legacy field's enum constraints.
2. **Cancellation wiring**: route HTTP/socket cancel requests through the
   outbox as a `task.cancel.requested` event consumed by the worker to emit
   `CANCEL_REQUESTED`.
3. **Per-run audit**: emit a `TaskExecutionEvent` of type `state_diverged` when
   the FSM and legacy lifecycle disagree, so operators can quantify
   divergence before cutover.

## Uncertain

- It is not clear whether `optimisticConcurrency` actually rejects stale
  `task.save()` calls in production, because the lease typically serializes
  writers per task. A targeted test would settle this.
- The transition `policy_blocked → queued` is in the legal table but no caller
  invokes it; whether it's intentionally reserved for an operator-initiated
  retry of a policy-blocked task is undocumented.
- It is unclear whether `cancelling → failed` is meant to record a failed
  cancellation handshake (e.g. worker abandoned mid-cancel) or is leftover
  permissiveness; the reducer does not implement it directly.
