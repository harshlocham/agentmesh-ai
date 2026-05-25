import type { TaskRecord } from "@chat/types";
import type { ITask } from "@chat/db/models/Task";

export function normalizeTask(doc: ITask): TaskRecord {
    return {
        _id: doc._id.toString(),
        conversationId: doc.conversationId.toString(),
        parentTaskId: doc.parentTaskId ? doc.parentTaskId.toString() : null,
        title: doc.title,
        description: doc.description,
        status: doc.status,
        priority: doc.priority,
        assignees: doc.assignees.map((assignee) => assignee.toString()),
        dueAt: doc.dueAt ? new Date(doc.dueAt).toISOString() : null,
        createdBy: doc.createdBy.toString(),
        source: doc.source,
        sourceMessageIds: doc.sourceMessageIds.map((messageId) => messageId.toString()),
        latestContextMessageId: doc.latestContextMessageId
            ? doc.latestContextMessageId.toString()
            : null,
        confidence: doc.confidence,
        tags: doc.tags,
        dedupeKey: doc.dedupeKey,
        subTasks: (doc.subTasks ?? []).map((subTaskId) => subTaskId.toString()),
        dependencyIds: (doc.dependencyIds ?? []).map((dependencyId) => dependencyId.toString()),
        retryCount: typeof doc.retryCount === "number" ? doc.retryCount : 0,
        maxRetries: typeof doc.maxRetries === "number" ? doc.maxRetries : 2,
        progress: typeof doc.progress === "number" ? doc.progress : 0,
        checkpoints: (doc.checkpoints ?? []).map((checkpoint) => ({
            step: checkpoint.step,
            status: checkpoint.status,
            timestamp: new Date(checkpoint.timestamp).toISOString(),
        })),
        executionHistory: {
            attempts: typeof doc.executionHistory?.attempts === "number" ? doc.executionHistory.attempts : 0,
            failures: typeof doc.executionHistory?.failures === "number" ? doc.executionHistory.failures : 0,
            results: (doc.executionHistory?.results ?? []).map((entry) => ({
                attempt: entry.attempt,
                success: entry.success,
                summary: entry.summary,
                ...(typeof entry.error === "string" && entry.error.length > 0 ? { error: entry.error } : {}),
                ...(entry.validationLog
                    ? {
                        validationLog: {
                            validator: entry.validationLog.validator,
                            passed: Boolean(entry.validationLog.passed),
                            checks: (entry.validationLog.checks ?? []).map((check) => ({
                                name: check.name,
                                passed: Boolean(check.passed),
                                ...(typeof check.details === "string" && check.details.length > 0 ? { details: check.details } : {}),
                            })),
                            evaluatedAt: new Date(entry.validationLog.evaluatedAt).toISOString(),
                        },
                    }
                    : {}),
                timestamp: new Date(entry.timestamp).toISOString(),
            })),
        },
        result: {
            success: Boolean(doc.result?.success),
            confidence: typeof doc.result?.confidence === "number" ? doc.result.confidence : 0,
            evidence: doc.result?.evidence ?? null,
            ...(typeof doc.result?.error === "string" && doc.result.error.length > 0
                ? { error: doc.result.error }
                : {}),
        },
        version: doc.version,
        closedAt: doc.closedAt ? new Date(doc.closedAt).toISOString() : null,
        archivedAt: doc.archivedAt ? new Date(doc.archivedAt).toISOString() : null,
        updatedBy: doc.updatedBy ? doc.updatedBy.toString() : null,
        createdAt: new Date(doc.createdAt).toISOString(),
        updatedAt: new Date(doc.updatedAt).toISOString(),
    };
}