import mongoose from "mongoose";
import TaskModel from "@chat/db/models/Task";
import * as dbModule from "@chat/db";
import type { TaskExecutionUpdatedPayload } from "@chat/types";
import { classifyExecutionError } from "./retry-classifier.js";

const connectToDatabase =
    (dbModule as unknown as { connectToDatabase?: () => Promise<unknown> }).connectToDatabase
    || ((dbModule as unknown as { default?: { connectToDatabase?: () => Promise<unknown> } }).default?.connectToDatabase)
    || (async () => undefined);

type TaskLike = {
    _id: { toString(): string };
    conversationId: { toString(): string };
    retryCount?: number;
    maxRetries?: number;
    save: () => Promise<void>;
    lifecycleState?: string;
    status?: string;
    nextRetryAt?: Date | null;
    lastRetryReason?: string | null;
    lastRetryAt?: Date | null;
};

export type ScheduleRetryResult =
    | { outcome: "scheduled"; retryCount: number; nextRetryAt: Date; decision: ReturnType<typeof classifyExecutionError> }
    | { outcome: "exhausted"; retryCount: number; decision: ReturnType<typeof classifyExecutionError> }
    | { outcome: "not_retryable"; retryCount: number; decision: ReturnType<typeof classifyExecutionError> };

export async function scheduleTaskRetry(
    task: TaskLike,
    error: unknown,
    options?: {
        emit?: (payload: TaskExecutionUpdatedPayload) => Promise<void> | void;
        runId?: string | null;
        actionType?: TaskExecutionUpdatedPayload["actionType"];
    }
): Promise<ScheduleRetryResult> {
    if (mongoose.connection.readyState !== 1) {
        await connectToDatabase();
    }

    const currentRetry = typeof task.retryCount === "number" ? task.retryCount : 0;
    const maxRetries = typeof task.maxRetries === "number" ? task.maxRetries : 2;
    const decision = classifyExecutionError(error, currentRetry);
    const nextRetryCount = currentRetry + 1;

    if (!decision.retryable || nextRetryCount > maxRetries) {
        task.lifecycleState = "failed";
        task.status = "failed";
        task.retryCount = nextRetryCount;
        task.lastRetryReason = decision.reason;
        task.lastRetryAt = new Date();

        if (mongoose.connection.readyState === 1) {
            await TaskModel.updateOne(
                { _id: task._id },
                {
                    $set: {
                        lifecycleState: "failed",
                        status: "failed",
                        retryCount: nextRetryCount,
                        lastRetryReason: decision.reason,
                        lastRetryAt: new Date(),
                    },
                }
            ).exec();
        } else if (typeof task.save === "function") {
            await task.save();
        }

        if (options?.emit) {
            await options.emit({
                taskId: task._id.toString(),
                conversationId: task.conversationId.toString(),
                state: "failed",
                actionType: options.actionType ?? "none",
                summary: decision.retryable ? "Retry budget exhausted." : "Execution failed (non-retryable).",
                error: decision.reason,
                updatedAt: new Date().toISOString(),
                runId: options.runId ?? undefined,
                phase: "finalize",
                step: "execution_failed",
                progress: 100,
            });
        }

        return {
            outcome: decision.retryable ? "exhausted" : "not_retryable",
            retryCount: nextRetryCount,
            decision,
        };
    }

    const nextRetryAt = new Date(Date.now() + decision.delayMs);
    task.lifecycleState = "retry_scheduled";
    task.status = "partial";
    task.retryCount = nextRetryCount;
    task.nextRetryAt = nextRetryAt;
    task.lastRetryReason = decision.reason;
    task.lastRetryAt = new Date();

    if (mongoose.connection.readyState === 1) {
        await TaskModel.updateOne(
            { _id: task._id },
            {
                $set: {
                    lifecycleState: "retry_scheduled",
                    status: "partial",
                    retryCount: nextRetryCount,
                    nextRetryAt,
                    lastRetryReason: decision.reason,
                    lastRetryAt: new Date(),
                },
            }
        ).exec();
    } else if (typeof task.save === "function") {
        await task.save();
    }

    if (options?.emit) {
        await options.emit({
            taskId: task._id.toString(),
            conversationId: task.conversationId.toString(),
            state: "queued",
            actionType: options.actionType ?? "none",
            summary: `Retry scheduled (${decision.category}).`,
            error: decision.reason,
            updatedAt: new Date().toISOString(),
            runId: options.runId ?? undefined,
            phase: "retry" as TaskExecutionUpdatedPayload["phase"],
            step: "retry_scheduled",
            progress: 0,
            attempt: nextRetryCount,
            details: {
                reasoning: `${decision.category} · retry in ${decision.delayMs}ms at ${nextRetryAt.toISOString()}`,
            },
        });
    }

    return {
        outcome: "scheduled",
        retryCount: nextRetryCount,
        nextRetryAt,
        decision,
    };
}
