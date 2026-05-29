import type {
    ExecutionEvent,
    ExecutionState,
    ExecutionStateKind,
} from "@chat/types";

export class InvalidExecutionTransitionError extends Error {
    constructor(from: ExecutionStateKind, eventType: ExecutionEvent["type"], detail?: string) {
        super(`Invalid execution transition from ${from} on ${eventType}${detail ? `: ${detail}` : ""}`);
        this.name = "InvalidExecutionTransitionError";
    }
}

type Edge = readonly [from: ExecutionStateKind, to: ExecutionStateKind];

export const LEGAL_EXECUTION_TRANSITIONS = [
    ["queued", "policy_evaluating"],
    ["queued", "cancelling"],

    ["policy_evaluating", "policy_blocked"],
    ["policy_evaluating", "awaiting_approval"],
    ["policy_evaluating", "planning"],
    ["policy_evaluating", "cancelling"],

    ["awaiting_approval", "planning"],
    ["awaiting_approval", "failed"],
    ["awaiting_approval", "blocked"],
    ["awaiting_approval", "cancelling"],

    ["policy_blocked", "queued"],
    ["policy_blocked", "cancelled"],

    ["planning", "ready_to_execute"],
    ["planning", "blocked"],
    ["planning", "failed"],
    ["planning", "cancelling"],

    ["ready_to_execute", "reasoning"],
    ["ready_to_execute", "blocked"],
    ["ready_to_execute", "cancelling"],

    ["reasoning", "tool_executing"],
    ["reasoning", "paused"],
    ["reasoning", "retry_scheduled"],
    ["reasoning", "succeeded"],
    ["reasoning", "failed"],
    ["reasoning", "cancelling"],

    ["tool_executing", "observing"],
    ["tool_executing", "paused"],
    ["tool_executing", "retry_scheduled"],
    ["tool_executing", "failed"],
    ["tool_executing", "cancelling"],

    ["observing", "verifying"],
    ["observing", "retry_scheduled"],
    ["observing", "failed"],
    ["observing", "cancelling"],

    ["verifying", "step_complete"],
    ["verifying", "reasoning"],
    ["verifying", "retry_scheduled"],
    ["verifying", "failed"],
    ["verifying", "cancelling"],

    ["step_complete", "reasoning"],
    ["step_complete", "succeeded"],
    ["step_complete", "cancelling"],

    ["blocked", "queued"],
    ["blocked", "failed"],
    ["blocked", "cancelled"],

    ["paused", "reasoning"],
    ["paused", "failed"],
    ["paused", "cancelling"],

    ["retry_scheduled", "queued"],
    ["retry_scheduled", "failed"],
    ["retry_scheduled", "cancelling"],

    ["cancelling", "cancelled"],
    ["cancelling", "failed"],
] as const satisfies readonly Edge[];

const transitionMap = new Map<ExecutionStateKind, ReadonlySet<ExecutionStateKind>>();

for (const [from, to] of LEGAL_EXECUTION_TRANSITIONS) {
    const existing = transitionMap.get(from);
    transitionMap.set(from, new Set([...(existing ?? []), to]));
}

export function canTransitionExecutionState(from: ExecutionStateKind, to: ExecutionStateKind): boolean {
    if (from === to) return false;
    return transitionMap.get(from)?.has(to) ?? false;
}

export function assertExecutionTransition(from: ExecutionStateKind, to: ExecutionStateKind, eventType: ExecutionEvent["type"]): void {
    if (!canTransitionExecutionState(from, to)) {
        throw new InvalidExecutionTransitionError(from, eventType, `target ${to} is not legal`);
    }
}

function requireRunOwned(state: ExecutionState, eventType: ExecutionEvent["type"]) {
    if (!("runId" in state) || !("workerId" in state) || !("leaseExpiresAt" in state)) {
        throw new InvalidExecutionTransitionError(state.kind, eventType, "state is not run-owned");
    }
    return state;
}

function transition(from: ExecutionState, to: ExecutionState, eventType: ExecutionEvent["type"]): ExecutionState {
    assertExecutionTransition(from.kind, to.kind, eventType);
    return to;
}

export function reduceExecutionState(state: ExecutionState, event: ExecutionEvent): ExecutionState {
    switch (event.type) {
        case "POLICY_EVALUATE":
            if (state.kind !== "queued") throw new InvalidExecutionTransitionError(state.kind, event.type);
            return transition(state, { kind: "policy_evaluating", queuedAt: state.queuedAt }, event.type);

        case "POLICY_BLOCKED":
            if (state.kind !== "policy_evaluating") throw new InvalidExecutionTransitionError(state.kind, event.type);
            return transition(state, { kind: "policy_blocked", reason: event.reason, decidedAt: event.decidedAt }, event.type);

        case "POLICY_APPROVAL_REQUIRED":
            if (state.kind !== "policy_evaluating") throw new InvalidExecutionTransitionError(state.kind, event.type);
            return transition(
                state,
                {
                    kind: "awaiting_approval",
                    actionType: event.actionType,
                    requestedAt: event.requestedAt,
                    ...(event.expiresAt ? { expiresAt: event.expiresAt } : {}),
                },
                event.type
            );

        case "LEASE_ACQUIRED":
            if (state.kind !== "policy_evaluating" && state.kind !== "awaiting_approval") {
                throw new InvalidExecutionTransitionError(state.kind, event.type);
            }
            return transition(
                state,
                { kind: "planning", runId: event.runId, workerId: event.workerId, leaseExpiresAt: event.leaseExpiresAt },
                event.type
            );

        case "APPROVAL_GRANTED":
            if (state.kind !== "awaiting_approval") throw new InvalidExecutionTransitionError(state.kind, event.type);
            return transition(
                state,
                { kind: "planning", runId: event.runId, workerId: event.workerId, leaseExpiresAt: event.leaseExpiresAt },
                event.type
            );

        case "APPROVAL_REJECTED":
            if (state.kind !== "awaiting_approval") throw new InvalidExecutionTransitionError(state.kind, event.type);
            return transition(
                state,
                { kind: "failed", reason: event.reason, lastError: event.reason, finishedAt: event.finishedAt },
                event.type
            );

        case "PLAN_READY": {
            const runState = requireRunOwned(state, event.type);
            if (runState.kind !== "planning") throw new InvalidExecutionTransitionError(state.kind, event.type);
            return transition(state, { ...runState, kind: "ready_to_execute" }, event.type);
        }

        case "ITERATION_START": {
            const runState = requireRunOwned(state, event.type);
            if (runState.kind !== "ready_to_execute" && runState.kind !== "step_complete" && runState.kind !== "verifying") {
                throw new InvalidExecutionTransitionError(state.kind, event.type);
            }
            return transition(
                state,
                {
                    kind: "reasoning",
                    runId: runState.runId,
                    workerId: runState.workerId,
                    leaseExpiresAt: runState.leaseExpiresAt,
                    iteration: event.iteration,
                },
                event.type
            );
        }

        case "TOOL_STARTED": {
            const runState = requireRunOwned(state, event.type);
            if (runState.kind !== "reasoning") throw new InvalidExecutionTransitionError(state.kind, event.type);
            return transition(
                state,
                {
                    kind: "tool_executing",
                    runId: runState.runId,
                    workerId: runState.workerId,
                    leaseExpiresAt: runState.leaseExpiresAt,
                    iteration: runState.iteration,
                    stepId: event.stepId,
                    toolName: event.toolName,
                    attempt: event.attempt,
                    idempotencyKey: event.idempotencyKey,
                },
                event.type
            );
        }

        case "TOOL_OBSERVED": {
            const runState = requireRunOwned(state, event.type);
            if (runState.kind !== "tool_executing") throw new InvalidExecutionTransitionError(state.kind, event.type);
            return transition(
                state,
                {
                    kind: "observing",
                    runId: runState.runId,
                    workerId: runState.workerId,
                    leaseExpiresAt: runState.leaseExpiresAt,
                    iteration: runState.iteration,
                    stepId: runState.stepId,
                    toolName: runState.toolName,
                },
                event.type
            );
        }

        case "TOOL_VERIFIED": {
            const runState = requireRunOwned(state, event.type);
            if (runState.kind !== "observing") throw new InvalidExecutionTransitionError(state.kind, event.type);
            return transition(
                state,
                {
                    kind: "verifying",
                    runId: runState.runId,
                    workerId: runState.workerId,
                    leaseExpiresAt: runState.leaseExpiresAt,
                    iteration: runState.iteration,
                    stepId: runState.stepId,
                    toolName: runState.toolName,
                },
                event.type
            );
        }

        case "STEP_COMPLETED": {
            const runState = requireRunOwned(state, event.type);
            if (runState.kind !== "verifying") throw new InvalidExecutionTransitionError(state.kind, event.type);
            return transition(
                state,
                {
                    kind: "step_complete",
                    runId: runState.runId,
                    workerId: runState.workerId,
                    leaseExpiresAt: runState.leaseExpiresAt,
                    iteration: runState.iteration,
                    stepId: runState.stepId,
                },
                event.type
            );
        }

        case "GOAL_ACHIEVED":
            if (state.kind !== "reasoning" && state.kind !== "step_complete") {
                throw new InvalidExecutionTransitionError(state.kind, event.type);
            }
            return transition(state, { kind: "succeeded", finishedAt: event.finishedAt, runId: event.runId, result: event.result }, event.type);

        case "CLARIFICATION_REQUIRED": {
            const runId = "runId" in state ? state.runId : undefined;
            return transition(
                state,
                {
                    kind: "paused",
                    reason: event.reason,
                    pendingClarification: {
                        question: event.question,
                        ...(event.pendingResolution ? { pendingResolution: event.pendingResolution } : {}),
                    },
                    ...(runId ? { runId } : {}),
                },
                event.type
            );
        }

        case "CLARIFICATION_RESOLVED":
            if (state.kind !== "paused" || !state.runId) throw new InvalidExecutionTransitionError(state.kind, event.type);
            return transition(
                state,
                {
                    kind: "reasoning",
                    runId: event.runId,
                    workerId: event.workerId,
                    leaseExpiresAt: event.leaseExpiresAt,
                    iteration: event.iteration,
                },
                event.type
            );

        case "BLOCKED": {
            const runId = "runId" in state ? state.runId : undefined;
            return transition(state, { kind: "blocked", reason: event.reason, ...(runId ? { runId } : {}) }, event.type);
        }

        case "ERROR_OCCURRED": {
            const runId = "runId" in state ? state.runId : undefined;
            if (event.retryable && event.retryCount <= event.maxRetries && event.nextRetryAt) {
                return transition(
                    state,
                    {
                        kind: "retry_scheduled",
                        retryCount: event.retryCount,
                        maxRetries: event.maxRetries,
                        nextRetryAt: event.nextRetryAt,
                        lastError: event.reason,
                        category: event.category,
                    },
                    event.type
                );
            }
            return transition(
                state,
                {
                    kind: "failed",
                    finishedAt: event.finishedAt,
                    reason: event.retryable ? "Retry budget exhausted." : "Execution failed.",
                    lastError: event.reason,
                    ...(runId ? { runId } : {}),
                },
                event.type
            );
        }

        case "RETRY_DUE":
            if (state.kind !== "retry_scheduled") throw new InvalidExecutionTransitionError(state.kind, event.type);
            return transition(state, { kind: "queued", queuedAt: event.queuedAt }, event.type);

        case "RETRY_BUDGET_EXHAUSTED":
            if (state.kind !== "retry_scheduled") throw new InvalidExecutionTransitionError(state.kind, event.type);
            return transition(
                state,
                {
                    kind: "failed",
                    finishedAt: event.finishedAt,
                    reason: "Retry budget exhausted.",
                    lastError: event.lastError,
                },
                event.type
            );

        case "CANCEL_REQUESTED": {
            const runId = "runId" in state ? state.runId : undefined;
            return transition(
                state,
                {
                    kind: "cancelling",
                    initiatedBy: event.initiatedBy,
                    reason: event.reason,
                    requestedAt: event.requestedAt,
                    ...(runId ? { runId } : {}),
                },
                event.type
            );
        }

        case "CANCEL_FINALIZED":
            if (state.kind !== "cancelling") throw new InvalidExecutionTransitionError(state.kind, event.type);
            return transition(state, { kind: "cancelled", reason: event.reason, cancelledAt: event.cancelledAt }, event.type);
    }
}
