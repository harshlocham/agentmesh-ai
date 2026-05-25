import type { TaskLifecycleState } from "@chat/db/models/Task";

export type TaskStateTransitionReason =
    | "plan_created"
    | "step_started"
    | "clarification_requested"
    | "fallback_triggered"
    | "fallback_executing"
    | "fallback_failed"
    | "approval_required"
    | "dependency_blocked"
    | "retry_scheduled"
    | "paused_by_system"
    | "resumed"
    | "completed"
    | "failed";

const TRANSITIONS: Record<TaskLifecycleState, TaskLifecycleState[]> = {
    planning: ["ready", "failed", "paused"],
    ready: ["executing", "waiting_for_approval", "blocked", "paused", "failed"],
    executing: ["retry_scheduled", "waiting_for_approval", "blocked", "paused", "completed", "failed"],
    waiting_for_approval: ["ready", "blocked", "paused", "failed"],
    blocked: ["ready", "paused", "failed"],
    retry_scheduled: ["ready", "executing", "blocked", "failed"],
    paused: ["ready", "executing", "failed"],
    completed: [],
    failed: [],
};

export function canTransition(from: TaskLifecycleState, to: TaskLifecycleState) {
    return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: TaskLifecycleState, to: TaskLifecycleState) {
    if (!canTransition(from, to)) {
        throw new Error(`Invalid task lifecycle transition: ${from} -> ${to}`);
    }
}
