import mongoose from "mongoose";
import TaskModel, { type ITask } from "@chat/db/models/Task";
import * as dbModule from "@chat/db";
import { enqueueOutboxEvent } from "@chat/services/outbox.service";
import type { TaskExecutionActionType } from "@chat/types";
import * as taskRepo from "@chat/services/repositories/task.repo";

const connectToDatabase =
    (dbModule as unknown as { connectToDatabase?: () => Promise<unknown> }).connectToDatabase
    || ((dbModule as unknown as { default?: { connectToDatabase?: () => Promise<unknown> } }).default?.connectToDatabase)
    || (async () => undefined);

export const RETRY_SCAN_INTERVAL_MS = Number(process.env.TASK_RETRY_SCAN_INTERVAL_MS || 5000);

function buildRetryPayload(task: ITask): Record<string, unknown> {
    const taskId = task._id.toString();
    const conversationId = task.conversationId.toString();
    const triggerMessageId = task.sourceMessageIds?.[0]?.toString() ?? taskId;

    return {
        taskId,
        conversationId,
        triggerMessageId,
        requestedByType: "system",
        requestedById: null,
        actionType: "none" as TaskExecutionActionType,
        parameters: {},
        confidence: typeof task.confidence === "number" ? task.confidence : 0.8,
        needsApproval: false,
        isRetry: true,
        retryCount: task.retryCount ?? 0,
    };
}

export async function runRetryScannerOnce(workerId: string): Promise<number> {
    await connectToDatabase();

    const now = new Date();
    const session = await mongoose.startSession();

    try {
        let enqueued = 0;
        await session.withTransaction(async () => {
            const candidate = await TaskModel.findOneAndUpdate(
                {
                    lifecycleState: "retry_scheduled",
                    nextRetryAt: { $lte: now },
                    $or: [
                        { leaseOwner: null },
                        { leaseExpiresAt: { $lt: now } },
                    ],
                },
                {
                    $set: {
                        lifecycleState: "ready",
                        lastRetryAt: now,
                    },
                },
                {
                    sort: { nextRetryAt: 1 },
                    new: true,
                    session,
                }
            ).exec();

            if (!candidate) {
                return;
            }

            const retryCount = candidate.retryCount ?? 0;
            await enqueueOutboxEvent({
                topic: "task.execution.requested",
                dedupeKey: `task.execution.requested:${candidate._id.toString()}:retry:${retryCount}`,
                payload: buildRetryPayload(candidate),
                session,
            });

            await taskRepo.createTaskAction({
                taskId: candidate._id.toString(),
                conversationId: candidate.conversationId.toString(),
                actorType: "system",
                actorId: null,
                actionType: "none",
                toolName: null,
                messageId: candidate.sourceMessageIds?.[0]?.toString() ?? null,
                parameters: { retryCount },
                executionState: "queued",
                summary: `Autonomous retry #${retryCount} enqueued.`,
                error: null,
                patch: { before: null, after: { retryCount, lastRetryReason: candidate.lastRetryReason } },
                reason: candidate.lastRetryReason ?? "Scheduled retry",
                idempotencyKey: `task.execution.requested:${candidate._id.toString()}:retry:${retryCount}:action`,
            }).catch((error: unknown) => {
                const maybeMongo = error as { code?: number };
                if (maybeMongo?.code !== 11000) {
                    throw error;
                }
            });

            console.info("task-worker retry.enqueued", {
                workerId,
                taskId: candidate._id.toString(),
                retryCount,
                runId: candidate.executionRunId ?? null,
            });

            enqueued = 1;
        });

        return enqueued;
    } finally {
        await session.endSession();
    }
}

export function startRetryScheduler(workerId: string): () => void {
    let stopped = false;

    const tick = async () => {
        if (stopped) {
            return;
        }

        try {
            await runRetryScannerOnce(workerId);
        } catch (error) {
            console.error("task-worker retry.scanner_failed", {
                workerId,
                error: error instanceof Error ? error.message : String(error),
            });
        }

        if (!stopped) {
            setTimeout(tick, RETRY_SCAN_INTERVAL_MS);
        }
    };

    void tick();

    return () => {
        stopped = true;
    };
}
