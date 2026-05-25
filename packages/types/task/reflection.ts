export type ReflectionOutcome = "completed" | "failed" | "partial";

export interface TaskReflection {
    _id: string;
    taskId: string;
    conversationId: string;
    runId?: string | null;
    outcome: ReflectionOutcome;
    whatWorked: string[];
    whatFailed: string[];
    improvements: string[];
    confidence: number;
    generatedByModel: string;
    createdAt: string;
}
