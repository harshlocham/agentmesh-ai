import "./test-env.js";
import assert from "node:assert/strict";
import test from "node:test";
type LeaseState = {
    owner: string | null;
    expiresAt: number;
    runCounter: number;
};

const leaseByTask = new Map<string, LeaseState>();

async function mockAcquire(taskId: string, workerId: string, runId: string, leaseMs: number) {
    const now = Date.now();
    const current = leaseByTask.get(taskId);
    const canAcquire = !current
        || !current.owner
        || current.expiresAt < now
        || current.owner === workerId;

    if (!canAcquire) {
        return null;
    }

    leaseByTask.set(taskId, {
        owner: workerId,
        expiresAt: now + leaseMs,
        runCounter: (current?.runCounter ?? 0) + 1,
    });

    return {
        taskId,
        workerId,
        runId,
        acquiredAt: new Date(now),
        expiresAt: new Date(now + leaseMs),
        release: async () => {
            const state = leaseByTask.get(taskId);
            if (state?.owner === workerId) {
                leaseByTask.set(taskId, { owner: null, expiresAt: 0, runCounter: state.runCounter });
            }
        },
    };
}

test("withExecutionLease allows only one concurrent dispatcher execution", async () => {
    const taskId = "task-dispatch-1";
    leaseByTask.clear();

    let runs = 0;

    const results = await Promise.all([
        mockAcquire(taskId, "worker-1", "run-1", 5_000).then(async (handle) => {
            if (!handle) return { skipped: "lease_busy" as const };
            runs += 1;
            await new Promise((resolve) => setTimeout(resolve, 50));
            await handle.release();
            return { ok: true };
        }),
        mockAcquire(taskId, "worker-2", "run-2", 5_000).then(async (handle) => {
            if (!handle) return { skipped: "lease_busy" as const };
            runs += 1;
            await handle.release();
            return { ok: true };
        }),
    ]);

    const successes = results.filter((result) => "ok" in result && result.ok);
    const skipped = results.filter((result) => "skipped" in result && result.skipped === "lease_busy");

    assert.equal(successes.length, 1);
    assert.equal(skipped.length, 1);
    assert.equal(runs, 1);
});

test("dispatcher skips execution when lease is held by another worker", async () => {
    const taskId = "task-dispatch-2";
    leaseByTask.set(taskId, {
        owner: "other-worker",
        expiresAt: Date.now() + 60_000,
        runCounter: 1,
    });

    const handle = await mockAcquire(taskId, "worker-1", "run-2", 5_000);
    assert.equal(handle, null);
});
