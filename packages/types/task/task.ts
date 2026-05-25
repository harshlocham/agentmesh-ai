export type TaskStatus = "pending" | "executing" | "completed" | "failed" | "partial" | "waiting_for_input";

export type TaskLifecycleState =
    | "planning"
    | "ready"
    | "executing"
    | "waiting_for_approval"
    | "blocked"
    | "retry_scheduled"
    | "paused"
    | "completed"
    | "failed";

export type TaskPriority = "low" | "medium" | "high" | "urgent";

export type TaskSource = "ai" | "manual" | "imported";

export type MessageSemanticType = "chat" | "task" | "decision" | "reminder" | "unknown";

export type MessageAiStatus = "pending" | "classified" | "failed" | "overridden";

export type TaskActionType =
    | "created"
    | "reassigned"
    | "status_changed"
    | "priority_changed"
    | "due_changed"
    | "linked_message"
    | "unlinked_message"
    | "commented"
    | "ai_reclassified"
    | "create_github_issue"
    | "schedule_meeting"
    | "send_email"
    | "none";

export type TaskActorType = "user" | "agent" | "system";

export type TaskLinkType = "source" | "context" | "decision";

export type TaskExecutionActionType = "create_github_issue" | "schedule_meeting" | "send_email" | "none";

export interface TaskResult {
    success: boolean;
    confidence: number;
    evidence: unknown;
    error?: string;
}

export interface TaskCheckpoint {
    step: string;
    status: string;
    timestamp: string;
}

export interface TaskExecutionHistoryResult {
    attempt: number;
    success: boolean;
    summary: string;
    error?: string;
    validationLog?: TaskValidationLog;
    timestamp: string;
}

export interface TaskValidationCheck {
    name: string;
    passed: boolean;
    details?: string;
}

export interface TaskValidationLog {
    validator: string;
    passed: boolean;
    checks: TaskValidationCheck[];
    evaluatedAt: string;
}

export interface TaskExecutionHistory {
    attempts: number;
    failures: number;
    results: TaskExecutionHistoryResult[];
}

export interface MessageTaskMetadata {
    semanticType?: MessageSemanticType;
    semanticConfidence?: number;
    aiStatus?: MessageAiStatus;
    aiVersion?: string | null;
    linkedTaskIds?: string[];
    manualOverride?: boolean;
    overrideBy?: string | null;
    overrideAt?: string | null;
    semanticProcessedAt?: string | null;
}

export interface TaskRecord {
    _id: string;
    conversationId: string;
    parentTaskId: string | null;
    title: string;
    description: string;
    status: TaskStatus;
    lifecycleState?: TaskLifecycleState;
    priority: TaskPriority;
    assignees: string[];
    dueAt: string | null;
    createdBy: string;
    source: TaskSource;
    sourceMessageIds: string[];
    latestContextMessageId: string | null;
    confidence: number;
    tags: string[];
    dedupeKey: string;
    subTasks: string[];
    dependencyIds: string[];
    retryCount: number;
    maxRetries: number;
    iterationCount?: number;
    currentRunId?: string | null;
    currentStepId?: string | null;
    leaseOwner?: string | null;
    leaseExpiresAt?: string | null;
    lastHeartbeatAt?: string | null;
    nextRetryAt?: string | null;
    blockedReason?: string | null;
    pausedReason?: string | null;
    progress: number;
    checkpoints: TaskCheckpoint[];
    executionHistory: TaskExecutionHistory;
    result: TaskResult;
    version: number;
    closedAt: string | null;
    archivedAt: string | null;
    updatedBy: string | null;
    createdAt: string;
    updatedAt: string;
}

export interface TaskActionRecord {
    _id: string;
    taskId: string;
    conversationId: string;
    actorType: TaskActorType;
    actorId: string | null;
    actionType: TaskActionType;
    toolName: string | null;
    messageId: string | null;
    executionState: "requested" | "approval_pending" | "approved" | "rejected" | "queued" | "running" | "succeeded" | "failed" | "blocked" | "expired" | null;
    summary: string | null;
    error: string | null;
    patch: {
        before: unknown | null;
        after: unknown | null;
    };
    reason: string;
    idempotencyKey: string;
    createdAt: string;
}

export interface MessageIntentRecord {
    _id: string;
    messageId: string;
    conversationId: string;
    intentType: "request" | "commit" | "reminder" | "decision" | "question" | "info";
    entities: {
        actionVerb: string;
        objectText: string;
        assigneeUserIds: string[];
        dueAtCandidate: string | null;
        priorityCandidate: TaskPriority | "";
    };
    confidence: number;
    extractorVersion: string;
    rawSummary: string;
    createdAt: string;
}