import TaskModel from "@chat/db/models/Task";
import * as dbModule from "@chat/db";

const connectToDatabase =
    (dbModule as unknown as { connectToDatabase?: () => Promise<unknown> }).connectToDatabase
    || ((dbModule as unknown as { default?: { connectToDatabase?: () => Promise<unknown> } }).default?.connectToDatabase)
    || (async () => undefined);

export const DEFAULT_LEASE_MS = Number(process.env.TASK_LEASE_MS || 30000);

export function getLeaseRenewalIntervalMs(leaseMs = DEFAULT_LEASE_MS) {
    return Math.max(1000, Math.floor(leaseMs / 3));
}

export async function acquireTaskLease(taskId: string, workerId: string, leaseMs = DEFAULT_LEASE_MS) {
    await connectToDatabase();

    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + leaseMs);

    const task = await TaskModel.findOneAndUpdate(
        {
            _id: taskId,
            $or: [
                { leaseOwner: null },
                { leaseExpiresAt: null },
                { leaseExpiresAt: { $lt: now } },
                { leaseOwner: workerId },
            ],
        },
        {
            $set: {
                leaseOwner: workerId,
                leaseExpiresAt,
                lastHeartbeatAt: now,
            },
        },
        { new: true }
    ).exec();

    return task;
}

export async function heartbeatTaskLease(taskId: string, workerId: string, leaseMs = DEFAULT_LEASE_MS) {
    await connectToDatabase();

    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + leaseMs);

    const task = await TaskModel.findOneAndUpdate(
        {
            _id: taskId,
            leaseOwner: workerId,
            leaseExpiresAt: { $gt: now },
        },
        {
            $set: {
                leaseExpiresAt,
                lastHeartbeatAt: now,
            },
        },
        { new: true }
    ).exec();

    return task;
}

export async function releaseTaskLease(taskId: string, workerId: string) {
    await connectToDatabase();

    return TaskModel.updateOne(
        {
            _id: taskId,
            leaseOwner: workerId,
        },
        {
            $set: {
                leaseOwner: null,
                leaseExpiresAt: null,
            },
        }
    ).exec();
}
