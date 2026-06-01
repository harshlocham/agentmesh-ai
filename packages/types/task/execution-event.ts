export type TaskExecutionEventType =
    | "execution_started"
    | "phase_transition"
    | "tool_selected"
    | "tool_started"
    | "tool_completed"
    | "tool_failed"
    | "retry_scheduled"
    | "retry_started"
    | "waiting_for_approval"
    | "waiting_for_input"
    | "verification"
    | "execution_completed"
    | "execution_failed";

export type TaskExecutionEventPhase =
    | "intake"
    | "policy"
    | "reason"
    | "tool_execute"
    | "observe"
    | "verify"
    | "finalize"
    | "retry";

export interface TaskExecutionEventRecord {
    _id: string;
    taskId: string;
    conversationId: string;
    runId: string;
    sequence: number;
    type: TaskExecutionEventType;
    phase: TaskExecutionEventPhase;
    payload: Record<string, unknown>;
    createdAt: string;
}
