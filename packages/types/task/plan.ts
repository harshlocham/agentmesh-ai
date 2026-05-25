export type TaskPlanStatus = "draft" | "approved" | "active" | "completed" | "failed" | "cancelled";

export type TaskStepState =
    | "ready"
    | "running"
    | "waiting_for_dependency"
    | "waiting_for_approval"
    | "retry_scheduled"
    | "blocked"
    | "completed"
    | "failed"
    | "skipped";

export type TaskStepKind = "tool_call" | "decision" | "approval" | "notification" | "validation";

export type TaskStepRiskLevel = "low" | "medium" | "high";

export type TaskStepFallbackPolicy = "dependency_preserving" | "immediate_execution";

export interface TaskStepFallback {
    stepId: string;
    reason: string;
}

export interface TaskStepToolCandidate {
    toolName: string;
    confidence: number;
    riskLevel: TaskStepRiskLevel;
}

export interface TaskStep {
    stepId: string;
    title: string;
    description: string;
    kind: TaskStepKind;
    order: number;
    dependencies: string[];
    fallbackPolicy: TaskStepFallbackPolicy;
    overrideDependencies: boolean;
    fallback: TaskStepFallback[];
    successCriteria: string[];
    toolCandidates: TaskStepToolCandidate[];
    selectedToolName?: string | null;
    input?: Record<string, unknown>;
    output?: Record<string, unknown>;
    state: TaskStepState;
    attempts: number;
    maxAttempts: number;
    lastError?: string | null;
    startedAt?: string | null;
    completedAt?: string | null;
}

export interface TaskPlan {
    _id: string;
    taskId: string;
    conversationId: string;
    goal: string;
    successDefinition: string;
    plannerModel: string;
    plannerVersion: string;
    status: TaskPlanStatus;
    steps: TaskStep[];
    activeStepId?: string | null;
    planNotes?: string | null;
    createdAt: string;
    updatedAt: string;
}

export interface PlannerContext {
    taskId: string;
    conversationId: string;
    title: string;
    description: string;
    sourceMessageIds: string[];
    availableTools: Array<{
        name: string;
        description: string;
    }>;
}
