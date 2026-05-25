import * as dbModule from "@chat/db";
import TaskMemoryModel from "@chat/db/models/TaskMemory";

const connectToDatabase =
    (dbModule as unknown as { connectToDatabase?: () => Promise<unknown> }).connectToDatabase
    || ((dbModule as unknown as { default?: { connectToDatabase?: () => Promise<unknown> } }).default?.connectToDatabase)
    || (async () => undefined);

export async function writeShortTermMemory(input: {
    taskId: string;
    conversationId: string;
    kind: "fact" | "pattern" | "failure" | "strategy" | "tool-feedback";
    summary: string;
    details?: string;
    tags?: string[];
    signalStrength?: number;
    successImpact?: number;
    toolName?: string;
}) {
    await connectToDatabase();

    return TaskMemoryModel.create({
        taskId: input.taskId,
        conversationId: input.conversationId,
        scope: "short_term",
        kind: input.kind,
        summary: input.summary,
        details: input.details ?? null,
        tags: input.tags ?? [],
        signalStrength: typeof input.signalStrength === "number" ? input.signalStrength : 0.5,
        successImpact: typeof input.successImpact === "number" ? input.successImpact : 0,
        toolName: input.toolName ?? null,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });
}

export async function writeLongTermMemory(input: {
    conversationId?: string;
    kind: "fact" | "pattern" | "failure" | "strategy" | "tool-feedback";
    summary: string;
    details?: string;
    tags?: string[];
    signalStrength?: number;
    successImpact?: number;
    toolName?: string;
}) {
    await connectToDatabase();

    return TaskMemoryModel.create({
        taskId: null,
        conversationId: input.conversationId ?? null,
        scope: "long_term",
        kind: input.kind,
        summary: input.summary,
        details: input.details ?? null,
        tags: input.tags ?? [],
        signalStrength: typeof input.signalStrength === "number" ? input.signalStrength : 0.6,
        successImpact: typeof input.successImpact === "number" ? input.successImpact : 0,
        toolName: input.toolName ?? null,
        expiresAt: null,
    });
}

export async function retrieveMemory(input: {
    taskId: string;
    conversationId: string;
    toolName?: string;
    limit?: number;
}) {
    await connectToDatabase();

    const limit = Math.max(1, Math.min(50, input.limit ?? 12));

    const [shortTerm, longTerm] = await Promise.all([
        TaskMemoryModel.find({
            scope: "short_term",
            taskId: input.taskId,
            $or: [
                { expiresAt: null },
                { expiresAt: { $gt: new Date() } },
            ],
        })
            .sort({ signalStrength: -1, updatedAt: -1 })
            .limit(limit)
            .lean()
            .exec(),
        TaskMemoryModel.find({
            scope: "long_term",
            ...(input.toolName ? { $or: [{ toolName: input.toolName }, { toolName: null }] } : {}),
        })
            .sort({ successImpact: -1, signalStrength: -1, updatedAt: -1 })
            .limit(limit)
            .lean()
            .exec(),
    ]);

    return {
        shortTerm,
        longTerm,
    };
}
