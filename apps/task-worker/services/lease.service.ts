import TaskModel from "@chat/db/models/Task";
import * as dbModule from "@chat/db";
import {
    DEFAULT_LEASE_MS,
    getLeaseRenewalIntervalMs,
    heartbeatTaskLease,
    releaseTaskLease,
} from "./task-lease.js";
import { logExecution } from "./execution-logger.js";

const connectToDatabase =
    (dbModule as unknown as { connectToDatabase?: () => Promise<unknown> }).connectToDatabase
    || ((dbModule as unknown as { default?: { connectToDatabase?: () => Promise<unknown> } }).default?.connectToDatabase)
    || (async () => undefined);

export interface LeaseHandle {
    taskId: string;
    workerId: string;
    runId: string;
    acquiredAt: Date;
    expiresAt: Date;
    release(): Promise<void>;
}

function generateRunId(taskId: string): string {
    const suffix = Math.random().toString(36).slice(2, 8);
    return `run-${taskId}-${Date.now()}-${suffix}`;
}

export async function acquireExecutionLease(args: {
    taskId: string;
    workerId: string;
    leaseMs?: number;
    runId?: string;
}): Promise<LeaseHandle | null> {
    await connectToDatabase();

    const leaseMs = args.leaseMs ?? DEFAULT_LEASE_MS;
    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + leaseMs);
    const runId = args.runId ?? generateRunId(args.taskId);

    const task = await TaskModel.findOneAndUpdate(
        {
            _id: args.taskId,
            $or: [
                { leaseOwner: null },
                { leaseExpiresAt: null },
                { leaseExpiresAt: { $lt: now } },
                { leaseOwner: args.workerId },
            ],
        },
        {
            $set: {
                leaseOwner: args.workerId,
                leaseExpiresAt,
                lastHeartbeatAt: now,
                executionRunId: runId,
                executionStartedAt: now,
                executionEventSequence: 0,
            },
        },
        { new: true }
    ).exec();

    if (!task) {
        logExecution("info", {
            event: "lease.busy",
            workerId: args.workerId,
            taskId: args.taskId,
        });
        return null;
    }

    logExecution("info", {
        event: "lease.acquired",
        workerId: args.workerId,
        taskId: args.taskId,
        runId,
        leaseExpiresAt: leaseExpiresAt.toISOString(),
    });

    return {
        taskId: args.taskId,
        workerId: args.workerId,
        runId,
        acquiredAt: now,
        expiresAt: leaseExpiresAt,
        release: async () => {
            await releaseTaskLease(args.taskId, args.workerId);
        },
    };
}

export type WithExecutionLeaseResult<T> = T | { skipped: "lease_busy" };

export class ExecutionLeaseBusyError extends Error {
    constructor(taskId: string) {
        super(`Task execution lease busy for task ${taskId}`);
        this.name = "ExecutionLeaseBusyError";
    }
}

export function assertExecutionLeaseCompleted<T>(
    taskId: string,
    result: WithExecutionLeaseResult<T>
): asserts result is T {
    if (result && typeof result === "object" && "skipped" in result && result.skipped === "lease_busy") {
        throw new ExecutionLeaseBusyError(taskId);
    }
}

export async function withExecutionLease<T>(
    args: { taskId: string; workerId: string; leaseMs?: number; runId?: string },
    fn: (handle: LeaseHandle, abortSignal: AbortSignal) => Promise<T>
): Promise<WithExecutionLeaseResult<T>> {
    const handle = await acquireExecutionLease(args);
    if (!handle) {
        return { skipped: "lease_busy" };
    }

    const leaseMs = args.leaseMs ?? DEFAULT_LEASE_MS;
    const intervalMs = getLeaseRenewalIntervalMs(leaseMs);
    const abortController = new AbortController();
    let heartbeatLost = false;

    const heartbeatTimer = setInterval(async () => {
        if (abortController.signal.aborted) {
            return;
        }

        try {
            const renewed = await heartbeatTaskLease(args.taskId, args.workerId, leaseMs);
            if (!renewed) {
                heartbeatLost = true;
                logExecution("warn", {
                    event: "lease.heartbeat.lost",
                    workerId: args.workerId,
                    taskId: args.taskId,
                    runId: handle.runId,
                });
                abortController.abort();
            } else {
                handle.expiresAt = renewed.leaseExpiresAt ?? handle.expiresAt;
            }
        } catch {
            heartbeatLost = true;
            abortController.abort();
        }
    }, intervalMs);

    try {
        const result = await fn(handle, abortController.signal);
        if (heartbeatLost) {
            throw new Error("LEASE_HEARTBEAT_LOST: execution lease expired during run");
        }
        return result;
    } finally {
        clearInterval(heartbeatTimer);
        await handle.release();
        logExecution("info", {
            event: "lease.released",
            workerId: args.workerId,
            taskId: args.taskId,
            runId: handle.runId,
        });
    }
}
