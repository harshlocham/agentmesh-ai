import type {
    ExecutionEvent,
    ExecutionState,
    ExecutionStateHistoryEntry,
    ExecutionStateKind,
} from "@chat/types";
import { isTerminalExecutionState } from "@chat/types";
import { reduceExecutionState } from "./execution-state-machine.js";

const SHADOW_HISTORY_LIMIT = 100;

export interface ShadowExecutionStateHistoryEntry extends ExecutionStateHistoryEntry {
    shadowError?: {
        name: string;
        message: string;
    };
}

export type ShadowTransitionResult =
    | {
        ok: true;
        from: ExecutionState;
        to: ExecutionState;
        historyEntry: ShadowExecutionStateHistoryEntry;
    }
    | {
        ok: false;
        from: ExecutionState;
        to: ExecutionState;
        historyEntry: ShadowExecutionStateHistoryEntry;
        error: Error;
    };

const EXECUTION_STATE_KINDS = new Set<ExecutionStateKind>([
    "queued",
    "policy_evaluating",
    "policy_blocked",
    "awaiting_approval",
    "planning",
    "ready_to_execute",
    "reasoning",
    "tool_executing",
    "observing",
    "verifying",
    "step_complete",
    "blocked",
    "paused",
    "retry_scheduled",
    "cancelling",
    "cancelled",
    "succeeded",
    "failed",
]);

export function isExecutionState(value: unknown): value is ExecutionState {
    return Boolean(
        value
        && typeof value === "object"
        && !Array.isArray(value)
        && typeof (value as { kind?: unknown }).kind === "string"
        && EXECUTION_STATE_KINDS.has((value as { kind: ExecutionStateKind }).kind)
    );
}

export function createQueuedShadowState(now = new Date()): ExecutionState {
    return {
        kind: "queued",
        queuedAt: now.toISOString(),
    };
}

export function resolveCurrentShadowState(value: unknown, now = new Date()): ExecutionState {
    return isExecutionState(value) ? value : createQueuedShadowState(now);
}

export function shouldResetShadowRunState(value: unknown): boolean {
    if (!isExecutionState(value)) {
        return true;
    }

    return isTerminalExecutionState(value);
}

export function reduceShadowExecutionEvent(input: {
    current: ExecutionState;
    event: ExecutionEvent;
    at?: Date;
    workerId?: string | null;
}): ShadowTransitionResult {
    const at = input.at ?? new Date();
    try {
        const to = reduceExecutionState(input.current, input.event);
        return {
            ok: true,
            from: input.current,
            to,
            historyEntry: {
                from: input.current,
                to,
                event: input.event,
                at: at.toISOString(),
                workerId: input.workerId ?? null,
            },
        };
    } catch (error) {
        const normalizedError = error instanceof Error ? error : new Error(String(error));
        return {
            ok: false,
            from: input.current,
            to: input.current,
            error: normalizedError,
            historyEntry: {
                from: input.current,
                to: input.current,
                event: input.event,
                at: at.toISOString(),
                workerId: input.workerId ?? null,
                shadowError: {
                    name: normalizedError.name,
                    message: normalizedError.message,
                },
            },
        };
    }
}

export function appendShadowHistory(
    history: ShadowExecutionStateHistoryEntry[] | undefined,
    entry: ShadowExecutionStateHistoryEntry,
    limit = SHADOW_HISTORY_LIMIT
): ShadowExecutionStateHistoryEntry[] {
    const next = [...(Array.isArray(history) ? history : []), entry];
    return next.slice(Math.max(0, next.length - limit));
}
