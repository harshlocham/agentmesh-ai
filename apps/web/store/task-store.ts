"use client";

import { create } from "zustand";
import type {
    MessageSemanticUpdatedPayload,
    TaskCreatedPayload,
    TaskExecutionUpdatedPayload,
    TaskLinkedToMessagePayload,
    TaskRecord,
    TaskUpdatedPayload,
} from "@chat/types";

interface TaskLinkState {
    taskId: string;
    messageId: string;
    linkType: "source" | "context" | "decision";
    taskVersion: number;
}

interface TaskStore {
    tasksById: Record<string, TaskRecord>;
    tasksByConversation: Record<string, string[]>;
    linksByMessageId: Record<string, TaskLinkState>;
    semanticByMessageId: Record<string, MessageSemanticUpdatedPayload>;
    executionByTaskId: Record<string, TaskExecutionUpdatedPayload>;

    setConversationTasks: (conversationId: string, tasks: TaskRecord[]) => void;
    upsertTask: (task: TaskRecord) => void;
    patchTask: (payload: TaskUpdatedPayload) => void;
    linkTaskToMessage: (payload: TaskLinkedToMessagePayload) => void;
    setMessageSemanticState: (payload: MessageSemanticUpdatedPayload) => void;
    setTaskExecutionState: (payload: TaskExecutionUpdatedPayload) => void;
    removeTask: (taskId: string) => void;
    resetConversationTasks: (conversationId: string) => void;
    handleTaskCreated: (payload: TaskCreatedPayload) => void;
}

const upsertConversationTaskId = (current: string[], taskId: string) => {
    if (current.includes(taskId)) return current;
    return [...current, taskId];
};

const removeConversationTaskId = (current: string[], taskId: string) => current.filter((entry) => entry !== taskId);

function buildPlaceholderTask(payload: TaskUpdatedPayload): TaskRecord {
    const now = new Date().toISOString();
    const patch = payload.patch as Partial<TaskRecord>;

    return {
        _id: payload.taskId,
        conversationId: payload.conversationId,
        parentTaskId: typeof patch.parentTaskId === "string" || patch.parentTaskId === null ? patch.parentTaskId : null,
        title: typeof patch.title === "string" ? patch.title : "Task",
        description: typeof patch.description === "string" ? patch.description : "",
        status: (patch.status as TaskRecord["status"]) ?? "pending",
        priority: (patch.priority as TaskRecord["priority"]) ?? "medium",
        assignees: Array.isArray(patch.assignees) ? patch.assignees : [],
        dueAt: typeof patch.dueAt === "string" || patch.dueAt === null ? patch.dueAt : null,
        createdBy: typeof patch.createdBy === "string" ? patch.createdBy : "",
        source: (patch.source as TaskRecord["source"]) ?? "ai",
        sourceMessageIds: Array.isArray(patch.sourceMessageIds) ? patch.sourceMessageIds : [],
        latestContextMessageId:
            typeof patch.latestContextMessageId === "string" || patch.latestContextMessageId === null
                ? patch.latestContextMessageId
                : null,
        confidence: typeof patch.confidence === "number" ? patch.confidence : 0,
        tags: Array.isArray(patch.tags) ? patch.tags : [],
        dedupeKey: typeof patch.dedupeKey === "string" ? patch.dedupeKey : `${payload.conversationId}::${payload.taskId}`,
        subTasks: Array.isArray(patch.subTasks) ? patch.subTasks : [],
        dependencyIds: Array.isArray(patch.dependencyIds) ? patch.dependencyIds : [],
        retryCount: typeof patch.retryCount === "number" ? patch.retryCount : 0,
        maxRetries: typeof patch.maxRetries === "number" ? patch.maxRetries : 2,
        progress: typeof patch.progress === "number" ? patch.progress : 0,
        checkpoints: Array.isArray(patch.checkpoints) ? patch.checkpoints : [],
        executionHistory: patch.executionHistory
            ? patch.executionHistory
            : { attempts: 0, failures: 0, results: [] },
        result: {
            success: Boolean((patch.result as TaskRecord["result"] | undefined)?.success),
            confidence: typeof (patch.result as TaskRecord["result"] | undefined)?.confidence === "number"
                ? ((patch.result as TaskRecord["result"]).confidence)
                : 0,
            evidence: (patch.result as TaskRecord["result"] | undefined)?.evidence ?? null,
            ...((patch.result as TaskRecord["result"] | undefined)?.error
                ? { error: (patch.result as TaskRecord["result"]).error }
                : {}),
        },
        version: payload.newVersion,
        closedAt: typeof patch.closedAt === "string" || patch.closedAt === null ? patch.closedAt : null,
        archivedAt: typeof patch.archivedAt === "string" || patch.archivedAt === null ? patch.archivedAt : null,
        updatedBy: typeof patch.updatedBy === "string" || patch.updatedBy === null ? patch.updatedBy : null,
        createdAt: typeof patch.createdAt === "string" ? patch.createdAt : now,
        updatedAt: now,
    };
}

const useTaskStore = create<TaskStore>((set, get) => ({
    tasksById: {},
    tasksByConversation: {},
    linksByMessageId: {},
    semanticByMessageId: {},
    executionByTaskId: {},

    setConversationTasks: (conversationId, tasks) =>
        set((state) => {
            const ids: string[] = [];
            const nextById = { ...state.tasksById };

            for (const task of tasks) {
                ids.push(task._id);
                nextById[task._id] = task;
            }

            return {
                tasksById: nextById,
                tasksByConversation: {
                    ...state.tasksByConversation,
                    [conversationId]: ids,
                },
            };
        }),

    upsertTask: (task) =>
        set((state) => ({
            tasksById: {
                ...state.tasksById,
                [task._id]: task,
            },
            tasksByConversation: {
                ...state.tasksByConversation,
                [task.conversationId]: upsertConversationTaskId(
                    state.tasksByConversation[task.conversationId] || [],
                    task._id
                ),
            },
        })),

    patchTask: (payload) =>
        set((state) => {
            const existing = state.tasksById[payload.taskId];
            if (!existing) {
                const created = buildPlaceholderTask(payload);
                return {
                    tasksById: {
                        ...state.tasksById,
                        [payload.taskId]: created,
                    },
                    tasksByConversation: {
                        ...state.tasksByConversation,
                        [payload.conversationId]: upsertConversationTaskId(
                            state.tasksByConversation[payload.conversationId] || [],
                            payload.taskId
                        ),
                    },
                };
            }
            if (existing.version >= payload.newVersion) return {};

            const nextTask: TaskRecord = {
                ...existing,
                ...payload.patch,
                version: payload.newVersion,
                updatedAt: new Date().toISOString(),
            };

            return {
                tasksById: {
                    ...state.tasksById,
                    [payload.taskId]: nextTask,
                },
                tasksByConversation: {
                    ...state.tasksByConversation,
                    [payload.conversationId]: upsertConversationTaskId(
                        state.tasksByConversation[payload.conversationId] || [],
                        payload.taskId
                    ),
                },
            };
        }),

    linkTaskToMessage: (payload) =>
        set((state) => ({
            linksByMessageId: {
                ...state.linksByMessageId,
                [payload.messageId]: {
                    taskId: payload.taskId,
                    messageId: payload.messageId,
                    linkType: payload.linkType,
                    taskVersion: payload.taskVersion,
                },
            },
            tasksByConversation: {
                ...state.tasksByConversation,
                [payload.conversationId]: upsertConversationTaskId(
                    state.tasksByConversation[payload.conversationId] || [],
                    payload.taskId
                ),
            },
        })),

    setMessageSemanticState: (payload) =>
        set((state) => ({
            semanticByMessageId: {
                ...state.semanticByMessageId,
                [payload.messageId]: payload,
            },
        })),

    setTaskExecutionState: (payload) =>
        set((state) => ({
            executionByTaskId: {
                ...state.executionByTaskId,
                [payload.taskId]: payload,
            },
            tasksById: state.tasksById[payload.taskId]
                ? {
                    ...state.tasksById,
                    [payload.taskId]: {
                        ...state.tasksById[payload.taskId],
                        status: payload.state === "running"
                            ? "executing"
                            : payload.state === "succeeded"
                                ? "completed"
                                : payload.state === "failed"
                                    ? "failed"
                                    : payload.state === "blocked" || payload.state === "approval_pending"
                                        ? "partial"
                                : state.tasksById[payload.taskId].status,
                        updatedAt: typeof payload.updatedAt === "string"
                            ? payload.updatedAt
                            : payload.updatedAt.toISOString(),
                    },
                }
                : state.tasksById,
        })),

    removeTask: (taskId) =>
        set((state) => {
            const existing = state.tasksById[taskId];
            if (!existing) return {};

            const nextTasksById = { ...state.tasksById };
            delete nextTasksById[taskId];

            const nextTasksByConversation = {
                ...state.tasksByConversation,
                [existing.conversationId]: removeConversationTaskId(
                    state.tasksByConversation[existing.conversationId] || [],
                    taskId
                ),
            };

            return {
                tasksById: nextTasksById,
                tasksByConversation: nextTasksByConversation,
            };
        }),

    resetConversationTasks: (conversationId) =>
        set((state) => ({
            tasksByConversation: {
                ...state.tasksByConversation,
                [conversationId]: [],
            },
        })),

    handleTaskCreated: (payload) =>
        get().upsertTask(payload.task),
}));

export default useTaskStore;