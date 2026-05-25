export type TaskMemoryScope = "short_term" | "long_term";

export type TaskMemoryKind = "fact" | "pattern" | "failure" | "strategy" | "tool-feedback";

export interface TaskMemory {
    _id: string;
    taskId?: string | null;
    conversationId?: string | null;
    scope: TaskMemoryScope;
    kind: TaskMemoryKind;
    summary: string;
    details?: string | null;
    tags: string[];
    signalStrength: number;
    successImpact: number;
    toolName?: string | null;
    createdAt: string;
    updatedAt: string;
    expiresAt?: string | null;
}

export interface MemoryRetrievalRequest {
    taskId: string;
    conversationId: string;
    query: string;
    toolName?: string;
    limit?: number;
}
