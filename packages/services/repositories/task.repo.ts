import { Types } from "mongoose";
import { createHash } from "node:crypto";
import { connectToDatabase } from "@chat/db";
import TaskModel, { ITask } from "@chat/db/models/Task";
import TaskActionModel, { ITaskAction } from "@chat/db/models/TaskAction";
import MessageModel, { IMessage } from "@chat/db/models/Message";
import type { CreateTaskActionInput, CreateTaskInput, LinkMessageToTaskInput, UpdateTaskInput } from "../validators/task.schema";

const toObjectId = (value: string) => new Types.ObjectId(value);

function normalizeForStableHash(value: unknown, seen: WeakSet<object>): unknown {
    if (value === null) return null;

    const valueType = typeof value;
    if (valueType === "string" || valueType === "number" || valueType === "boolean") {
        return value;
    }

    if (valueType === "undefined") {
        return "[Undefined]";
    }

    if (valueType === "bigint") {
        return (value as bigint).toString();
    }

    if (valueType === "symbol") {
        return (value as symbol).toString();
    }

    if (valueType === "function") {
        return "[Function]";
    }

    if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? "[Invalid Date]" : value.toISOString();
    }

    if (value instanceof Types.ObjectId) {
        return value.toHexString();
    }

    if (valueType !== "object") {
        return String(value);
    }

    const objectValue = value as object;
    if (seen.has(objectValue)) {
        return "[Circular]";
    }
    seen.add(objectValue);

    try {
        const maybeToJSON = (value as { toJSON?: () => unknown }).toJSON;
        if (typeof maybeToJSON === "function") {
            try {
                return normalizeForStableHash(maybeToJSON.call(value), seen);
            } catch {
                return "[toJSON-error]";
            }
        }

        if (Array.isArray(value)) {
            return value.map((entry) => normalizeForStableHash(entry, seen));
        }

        const output: Record<string, unknown> = {};
        const keys = Object.keys(value as Record<string, unknown>).sort();
        for (const key of keys) {
            output[key] = normalizeForStableHash((value as Record<string, unknown>)[key], seen);
        }

        return output;
    } finally {
        seen.delete(objectValue);
    }
}

function stableStringify(value: unknown): string {
    const normalized = normalizeForStableHash(value, new WeakSet<object>());
    return JSON.stringify(normalized);
}

export function buildTaskDedupeKey(
    conversationId: string,
    toolName: string,
    parameters: Record<string, unknown> = {},
    sourceMessageId?: string | null
) {
    const normalizedToolName = toolName.trim().toLowerCase();
    const hashInput = stableStringify({
        toolName: normalizedToolName,
        parameters,
    });

    const digest = createHash("sha256").update(hashInput).digest("hex");
    return [conversationId, digest, sourceMessageId ?? ""].join("::");
}

export function buildTaskActionIdempotencyKey(taskId: string, actionType: string, sourceId?: string | null) {
    return [taskId, actionType, sourceId ?? ""].join("::");
}

export function deriveTaskDedupeKey(input: {
    conversationId: string;
    title?: string;
    sourceMessageId?: string | null;
    toolName?: string;
    parameters?: Record<string, unknown>;
}) {
    const toolName = input.toolName ?? "manual";
    const parameters = input.parameters ?? (input.title
        ? { title: input.title.trim().toLowerCase().replace(/\s+/g, " ") }
        : {});

    return buildTaskDedupeKey(input.conversationId, toolName, parameters, input.sourceMessageId ?? null);
}

export async function createTask(input: CreateTaskInput): Promise<ITask> {
    await connectToDatabase();

    const task = new TaskModel({
        conversationId: toObjectId(input.conversationId),
        parentTaskId: input.parentTaskId ? toObjectId(input.parentTaskId) : null,
        title: input.title,
        description: input.description ?? "",
        status: "pending",
        priority: input.priority ?? "medium",
        assignees: input.assignees.map(toObjectId),
        dueAt: input.dueAt ?? null,
        createdBy: toObjectId(input.createdBy),
        source: input.source,
        sourceMessageIds: input.sourceMessageIds.map(toObjectId),
        latestContextMessageId: input.latestContextMessageId ? toObjectId(input.latestContextMessageId) : null,
        confidence: input.confidence ?? 1,
        tags: input.tags ?? [],
        dedupeKey: input.dedupeKey,
        subTasks: input.subTasks?.map(toObjectId) ?? [],
        dependencyIds: input.dependencyIds?.map(toObjectId) ?? [],
        retryCount: 0,
        maxRetries: 2,
        lifecycleState: input.lifecycleState ?? "ready",
        iterationCount: input.iterationCount ?? 0,
        currentRunId: input.currentRunId ? toObjectId(input.currentRunId) : null,
        currentStepId: input.currentStepId ?? null,
        leaseOwner: input.leaseOwner ?? null,
        leaseExpiresAt: input.leaseExpiresAt ?? null,
        lastHeartbeatAt: input.lastHeartbeatAt ?? null,
        nextRetryAt: input.nextRetryAt ?? null,
        blockedReason: input.blockedReason ?? null,
        pausedReason: input.pausedReason ?? null,
        progress: input.progress ?? 0,
        checkpoints: input.checkpoints ?? [],
        executionHistory: input.executionHistory ?? {
            attempts: 0,
            failures: 0,
            results: [],
        },
        result: {
            success: false,
            confidence: 0,
            evidence: null,
        },
    });

    await task.save();
    return task;
}

export async function upsertTaskByDedupeKey(input: CreateTaskInput): Promise<ITask> {
    await connectToDatabase();

    const task = await TaskModel.findOneAndUpdate(
        { dedupeKey: input.dedupeKey },
        {
            $setOnInsert: {
                conversationId: toObjectId(input.conversationId),
                parentTaskId: input.parentTaskId ? toObjectId(input.parentTaskId) : null,
                title: input.title,
                description: input.description ?? "",
                status: "pending",
                priority: input.priority ?? "medium",
                assignees: input.assignees.map(toObjectId),
                dueAt: input.dueAt ?? null,
                createdBy: toObjectId(input.createdBy),
                source: input.source,
                sourceMessageIds: input.sourceMessageIds.map(toObjectId),
                latestContextMessageId: input.latestContextMessageId ? toObjectId(input.latestContextMessageId) : null,
                confidence: input.confidence ?? 1,
                tags: input.tags ?? [],
                dedupeKey: input.dedupeKey,
                subTasks: input.subTasks?.map(toObjectId) ?? [],
                dependencyIds: input.dependencyIds?.map(toObjectId) ?? [],
                retryCount: 0,
                maxRetries: 2,
                lifecycleState: input.lifecycleState ?? "ready",
                iterationCount: input.iterationCount ?? 0,
                currentRunId: input.currentRunId ? toObjectId(input.currentRunId) : null,
                currentStepId: input.currentStepId ?? null,
                leaseOwner: input.leaseOwner ?? null,
                leaseExpiresAt: input.leaseExpiresAt ?? null,
                lastHeartbeatAt: input.lastHeartbeatAt ?? null,
                nextRetryAt: input.nextRetryAt ?? null,
                blockedReason: input.blockedReason ?? null,
                pausedReason: input.pausedReason ?? null,
                progress: input.progress ?? 0,
                checkpoints: input.checkpoints ?? [],
                executionHistory: input.executionHistory ?? {
                    attempts: 0,
                    failures: 0,
                    results: [],
                },
                result: {
                    success: false,
                    confidence: 0,
                    evidence: null,
                },
            },
        },
        { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    if (!task) {
        throw new Error("Failed to create or load task");
    }

    return task;
}

export async function updateTask(update: UpdateTaskInput): Promise<ITask | null> {
    await connectToDatabase();

    const next = await TaskModel.findByIdAndUpdate(
        update.taskId,
        {
            ...(update.title !== undefined ? { title: update.title } : {}),
            ...(update.description !== undefined ? { description: update.description } : {}),
            ...(update.status !== undefined ? { status: update.status } : {}),
            ...(update.priority !== undefined ? { priority: update.priority } : {}),
            ...(update.assignees !== undefined ? { assignees: update.assignees.map(toObjectId) } : {}),
            ...(update.dueAt !== undefined ? { dueAt: update.dueAt } : {}),
            ...(update.tags !== undefined ? { tags: update.tags } : {}),
            ...(update.parentTaskId !== undefined
                ? { parentTaskId: update.parentTaskId ? toObjectId(update.parentTaskId) : null }
                : {}),
            ...(update.subTasks !== undefined ? { subTasks: update.subTasks.map(toObjectId) } : {}),
            ...(update.dependencyIds !== undefined ? { dependencyIds: update.dependencyIds.map(toObjectId) } : {}),
            ...(update.latestContextMessageId !== undefined
                ? { latestContextMessageId: update.latestContextMessageId ? toObjectId(update.latestContextMessageId) : null }
                : {}),
            ...(update.result !== undefined ? { result: update.result } : {}),
            ...(update.retryCount !== undefined ? { retryCount: update.retryCount } : {}),
            ...(update.maxRetries !== undefined ? { maxRetries: update.maxRetries } : {}),
            ...(update.progress !== undefined ? { progress: update.progress } : {}),
            ...(update.checkpoints !== undefined ? { checkpoints: update.checkpoints } : {}),
            ...(update.executionHistory !== undefined ? { executionHistory: update.executionHistory } : {}),
            ...(update.updatedBy !== undefined
                ? { updatedBy: update.updatedBy ? toObjectId(update.updatedBy) : null }
                : {}),
        },
        { new: true }
    );

    return next;
}

export async function createTaskAction(input: CreateTaskActionInput): Promise<ITaskAction> {
    await connectToDatabase();

    const action = new TaskActionModel({
        taskId: toObjectId(input.taskId),
        conversationId: toObjectId(input.conversationId),
        actorType: input.actorType,
        actorId: input.actorId ? toObjectId(input.actorId) : null,
        actionType: input.actionType,
        toolName: input.toolName ?? input.actionType,
        messageId: input.messageId ? toObjectId(input.messageId) : null,
        parameters: input.parameters ?? {},
        executionState: input.executionState ?? null,
        summary: input.summary ?? null,
        error: input.error ?? null,
        patch: input.patch,
        reason: input.reason,
        idempotencyKey: input.idempotencyKey,
    });

    await action.save();
    return action;
}

export async function getLatestExecutionTaskAction(taskId: string): Promise<ITaskAction | null> {
    await connectToDatabase();

    return TaskActionModel.findOne({
        taskId: toObjectId(taskId),
    })
        .sort({ createdAt: -1 })
        .exec();
}

export async function migrateTaskActionToolNames(taskId?: string): Promise<{ matchedCount: number; modifiedCount: number }> {
    await connectToDatabase();

    const query: Record<string, unknown> = {
        $or: [
            { toolName: { $exists: false } },
            { toolName: null },
            { toolName: "" },
        ],
    };

    if (taskId) {
        query.taskId = toObjectId(taskId);
    }

    const result = await TaskActionModel.updateMany(query, [
        {
            $set: {
                toolName: "$actionType",
            },
        },
    ]);

    return {
        matchedCount: result.matchedCount,
        modifiedCount: result.modifiedCount,
    };
}

export async function getTaskActionById(taskActionId: string): Promise<ITaskAction | null> {
    await connectToDatabase();
    return TaskActionModel.findById(toObjectId(taskActionId)).exec();
}

export async function getPendingApprovalTaskActions(conversationId?: string): Promise<ITaskAction[]> {
    await connectToDatabase();

    const query: Record<string, unknown> = {
        executionState: "approval_pending",
    };

    if (conversationId) {
        query.conversationId = toObjectId(conversationId);
    }

    return TaskActionModel.find(query)
        .sort({ createdAt: -1 })
        .exec();
}

export async function updateTaskActionExecutionState(input: {
    taskActionId: string;
    executionState: ITaskAction["executionState"];
    summary?: string | null;
    error?: string | null;
    parameters?: Record<string, unknown>;
    reason?: string;
    patch?: {
        before: unknown | null;
        after: unknown | null;
    };
}): Promise<ITaskAction | null> {
    await connectToDatabase();

    return TaskActionModel.findByIdAndUpdate(
        input.taskActionId,
        {
            executionState: input.executionState,
            ...(input.summary !== undefined ? { summary: input.summary } : {}),
            ...(input.error !== undefined ? { error: input.error } : {}),
            ...(input.parameters !== undefined ? { parameters: input.parameters } : {}),
            ...(input.reason !== undefined ? { reason: input.reason } : {}),
            ...(input.patch !== undefined ? { patch: input.patch } : {}),
        },
        { new: true }
    ).exec();
}

export async function linkMessageToTask(input: LinkMessageToTaskInput) {
    await connectToDatabase();

    const [message, task] = await Promise.all([
        MessageModel.findById(input.messageId),
        TaskModel.findById(input.taskId),
    ]);

    if (!message) {
        throw new Error("Message not found");
    }

    if (!task) {
        throw new Error("Task not found");
    }

    await MessageModel.updateOne(
        { _id: message._id },
        {
            $addToSet: { linkedTaskIds: task._id },
            $set: {
                semanticType: "task",
                aiStatus: "classified",
                semanticProcessedAt: new Date(),
            },
        }
    );

    await TaskModel.updateOne(
        { _id: task._id },
        {
            $addToSet: { sourceMessageIds: message._id },
            $set: { latestContextMessageId: message._id },
        }
    );

    return {
        taskId: task._id.toString(),
        messageId: message._id.toString(),
        conversationId: input.conversationId,
        linkType: input.linkType,
    };
}

export async function updateMessageSemanticState(messageId: string, patch: Partial<Pick<IMessage, "semanticType" | "semanticConfidence" | "aiStatus" | "aiVersion" | "manualOverride" | "semanticProcessedAt">> & {
    linkedTaskIds?: string[];
    overrideBy?: string | null;
    overrideAt?: Date | null;
}) {
    await connectToDatabase();

    const update: Record<string, unknown> = {};

    if (patch.semanticType !== undefined) update.semanticType = patch.semanticType;
    if (patch.semanticConfidence !== undefined) update.semanticConfidence = patch.semanticConfidence;
    if (patch.aiStatus !== undefined) update.aiStatus = patch.aiStatus;
    if (patch.aiVersion !== undefined) update.aiVersion = patch.aiVersion;
    if (patch.manualOverride !== undefined) update.manualOverride = patch.manualOverride;
    if (patch.semanticProcessedAt !== undefined) update.semanticProcessedAt = patch.semanticProcessedAt;
    if (patch.overrideBy !== undefined) update.overrideBy = patch.overrideBy ? new Types.ObjectId(patch.overrideBy) : null;
    if (patch.overrideAt !== undefined) update.overrideAt = patch.overrideAt;
    if (patch.linkedTaskIds !== undefined) {
        update.linkedTaskIds = patch.linkedTaskIds.map((id) => new Types.ObjectId(id));
    }

    return MessageModel.updateOne({ _id: messageId }, { $set: update });
}