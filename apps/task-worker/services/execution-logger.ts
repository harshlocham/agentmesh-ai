export type ExecutionLogLevel = "info" | "warn" | "error";

export interface ExecutionLogFields {
    event: string;
    workerId?: string;
    runId?: string;
    taskId?: string;
    leaseOwner?: string;
    durationMs?: number;
    phase?: string;
    toolName?: string;
    retryCount?: number;
    category?: string;
    error?: string;
    [key: string]: unknown;
}

export function logExecution(level: ExecutionLogLevel, fields: ExecutionLogFields): void {
    const line = JSON.stringify({
        level,
        ts: new Date().toISOString(),
        component: "task-worker",
        ...fields,
    });

    if (level === "error") {
        console.error(line);
        return;
    }

    if (level === "warn") {
        console.warn(line);
        return;
    }

    console.info(line);
}
