import type { TaskExecutionActionType, TaskLifecycleState, TaskStatus } from "./task.js";

export type ExecutionStateKind =
    | "queued"
    | "policy_evaluating"
    | "policy_blocked"
    | "awaiting_approval"
    | "planning"
    | "ready_to_execute"
    | "reasoning"
    | "tool_executing"
    | "observing"
    | "verifying"
    | "step_complete"
    | "blocked"
    | "paused"
    | "retry_scheduled"
    | "cancelling"
    | "cancelled"
    | "succeeded"
    | "failed";

export type ExecutionActorType = "user" | "agent" | "system";

export interface ExecutionResultSnapshot {
    confidence: number;
    summary: string;
    evidence: unknown;
}

export interface RunOwnedExecutionStateBase {
    runId: string;
    workerId: string;
    leaseExpiresAt: string;
}

export type ExecutionState =
    | { kind: "queued"; queuedAt: string }
    | { kind: "policy_evaluating"; queuedAt: string }
    | { kind: "policy_blocked"; reason: string; decidedAt: string }
    | { kind: "awaiting_approval"; actionType: TaskExecutionActionType; requestedAt: string; expiresAt?: string }
    | ({ kind: "planning" } & RunOwnedExecutionStateBase)
    | ({ kind: "ready_to_execute" } & RunOwnedExecutionStateBase)
    | ({ kind: "reasoning"; iteration: number } & RunOwnedExecutionStateBase)
    | ({
        kind: "tool_executing";
        iteration: number;
        stepId: string;
        toolName: string;
        attempt: number;
        idempotencyKey: string;
    } & RunOwnedExecutionStateBase)
    | ({ kind: "observing"; iteration: number; stepId: string; toolName: string } & RunOwnedExecutionStateBase)
    | ({ kind: "verifying"; iteration: number; stepId: string; toolName: string } & RunOwnedExecutionStateBase)
    | ({ kind: "step_complete"; iteration: number; stepId: string } & RunOwnedExecutionStateBase)
    | { kind: "blocked"; reason: string; runId?: string }
    | {
        kind: "paused";
        reason: string;
        pendingClarification?: {
            question: string;
            pendingResolution?: unknown;
        };
        runId?: string;
    }
    | {
        kind: "retry_scheduled";
        retryCount: number;
        maxRetries: number;
        nextRetryAt: string;
        lastError: string;
        category: string;
    }
    | { kind: "cancelling"; initiatedBy: ExecutionActorType; reason: string; requestedAt: string; runId?: string }
    | { kind: "cancelled"; reason: string; cancelledAt: string }
    | { kind: "succeeded"; finishedAt: string; runId: string; result: ExecutionResultSnapshot }
    | { kind: "failed"; finishedAt: string; reason: string; lastError: string; runId?: string };

export type ExecutionEvent =
    | { type: "POLICY_EVALUATE" }
    | { type: "POLICY_BLOCKED"; reason: string; decidedAt: string }
    | { type: "POLICY_APPROVAL_REQUIRED"; actionType: TaskExecutionActionType; requestedAt: string; expiresAt?: string }
    | { type: "APPROVAL_GRANTED"; runId: string; workerId: string; leaseExpiresAt: string }
    | { type: "APPROVAL_REJECTED"; reason: string; finishedAt: string }
    | { type: "LEASE_ACQUIRED"; runId: string; workerId: string; leaseExpiresAt: string }
    | { type: "PLAN_READY" }
    | { type: "ITERATION_START"; iteration: number }
    | { type: "TOOL_STARTED"; stepId: string; toolName: string; attempt: number; idempotencyKey: string }
    | { type: "TOOL_OBSERVED" }
    | { type: "TOOL_VERIFIED" }
    | { type: "STEP_COMPLETED" }
    | { type: "GOAL_ACHIEVED"; finishedAt: string; runId: string; result: ExecutionResultSnapshot }
    | { type: "CLARIFICATION_REQUIRED"; reason: string; question: string; pendingResolution?: unknown }
    | { type: "CLARIFICATION_RESOLVED"; runId: string; workerId: string; leaseExpiresAt: string; iteration: number }
    | { type: "BLOCKED"; reason: string }
    | {
        type: "ERROR_OCCURRED";
        reason: string;
        retryable: boolean;
        category: string;
        retryCount: number;
        maxRetries: number;
        nextRetryAt?: string;
        finishedAt: string;
    }
    | { type: "RETRY_DUE"; queuedAt: string }
    | { type: "RETRY_BUDGET_EXHAUSTED"; lastError: string; finishedAt: string }
    | { type: "CANCEL_REQUESTED"; initiatedBy: ExecutionActorType; reason: string; requestedAt: string }
    | { type: "CANCEL_FINALIZED"; reason: string; cancelledAt: string };

export interface ExecutionStateHistoryEntry {
    from: ExecutionState;
    to: ExecutionState;
    event: ExecutionEvent;
    at: string;
    workerId?: string | null;
}

export const TERMINAL_EXECUTION_STATES = ["succeeded", "failed", "cancelled"] as const satisfies readonly ExecutionStateKind[];

export const RUN_OWNED_EXECUTION_STATES = [
    "planning",
    "ready_to_execute",
    "reasoning",
    "tool_executing",
    "observing",
    "verifying",
    "step_complete",
] as const satisfies readonly ExecutionStateKind[];

export function isTerminalExecutionState(state: ExecutionState): boolean {
    return (TERMINAL_EXECUTION_STATES as readonly string[]).includes(state.kind);
}

export function isRunOwnedExecutionState(state: ExecutionState): state is Extract<ExecutionState, RunOwnedExecutionStateBase> {
    return (RUN_OWNED_EXECUTION_STATES as readonly string[]).includes(state.kind);
}

export function deriveLegacyLifecycleState(state: ExecutionState): TaskLifecycleState {
    switch (state.kind) {
        case "queued":
        case "policy_evaluating":
            return "ready";
        case "policy_blocked":
            return "failed";
        case "awaiting_approval":
            return "waiting_for_approval";
        case "planning":
            return "planning";
        case "ready_to_execute":
        case "reasoning":
        case "tool_executing":
        case "observing":
        case "verifying":
        case "step_complete":
        case "cancelling":
            return "executing";
        case "blocked":
            return "blocked";
        case "paused":
            return "paused";
        case "retry_scheduled":
            return "retry_scheduled";
        case "cancelled":
        case "failed":
            return "failed";
        case "succeeded":
            return "completed";
    }
}

export function deriveLegacyTaskStatus(state: ExecutionState): TaskStatus {
    switch (state.kind) {
        case "queued":
        case "policy_evaluating":
        case "planning":
        case "ready_to_execute":
            return "pending";
        case "reasoning":
        case "tool_executing":
        case "observing":
        case "verifying":
        case "step_complete":
        case "cancelling":
            return "executing";
        case "awaiting_approval":
        case "blocked":
        case "retry_scheduled":
            return "partial";
        case "paused":
            return "waiting_for_input";
        case "policy_blocked":
        case "cancelled":
        case "failed":
            return "failed";
        case "succeeded":
            return "completed";
    }
}
