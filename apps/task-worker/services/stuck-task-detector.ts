import TaskModel from "@chat/db/models/Task";
import * as dbModule from "@chat/db";
import { logExecution } from "./execution-logger.js";

const connectToDatabase =
    (dbModule as unknown as { connectToDatabase?: () => Promise<unknown> }).connectToDatabase
    || ((dbModule as unknown as { default?: { connectToDatabase?: () => Promise<unknown> } }).default?.connectToDatabase)
    || (async () => undefined);

export const STUCK_DETECTION_INTERVAL_MS = Number(process.env.TASK_STUCK_DETECTION_INTERVAL_MS || 60000);
const STUCK_HEARTBEAT_MS = Number(process.env.TASK_STUCK_HEARTBEAT_MS || 5 * 60 * 1000);

export async function detectStuckTasksOnce(workerId: string): Promise<number> {
    await connectToDatabase();

    const cutoff = new Date(Date.now() - STUCK_HEARTBEAT_MS);
    const stuck = await TaskModel.find({
        lifecycleState: "executing",
        lastHeartbeatAt: { $lt: cutoff },
    })
        .select({ _id: 1, executionRunId: 1, leaseOwner: 1, lastHeartbeatAt: 1 })
        .limit(20)
        .lean()
        .exec();

    for (const task of stuck) {
        logExecution("warn", {
            event: "stuck_task.detected",
            workerId,
            taskId: task._id.toString(),
            runId: task.executionRunId ?? undefined,
            leaseOwner: task.leaseOwner ?? undefined,
            lastHeartbeatAt: task.lastHeartbeatAt?.toISOString(),
        });
    }

    return stuck.length;
}

export function startStuckTaskDetector(workerId: string): () => void {
    let stopped = false;

    const tick = async () => {
        if (stopped) {
            return;
        }

        try {
            await detectStuckTasksOnce(workerId);
        } catch (error) {
            logExecution("error", {
                event: "stuck_task.scanner_failed",
                workerId,
                error: error instanceof Error ? error.message : String(error),
            });
        }

        if (!stopped) {
            setTimeout(tick, STUCK_DETECTION_INTERVAL_MS);
        }
    };

    void tick();

    return () => {
        stopped = true;
    };
}
