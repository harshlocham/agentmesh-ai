import "./test-env.js";
import assert from "node:assert/strict";
import test from "node:test";

type LeaseDoc = {
    _id: string;
    leaseOwner: string | null;
    leaseExpiresAt: Date | null;
    executionRunId: string | null;
    executionStartedAt: Date | null;
    executionEventSequence: number;
};

function createLeaseStore() {
    const docs = new Map<string, LeaseDoc>();

    return {
        docs,
        async acquire(taskId: string, workerId: string, runId: string, leaseMs: number) {
            const now = new Date();
            const existing = docs.get(taskId);
            const canAcquire = !existing
                || !existing.leaseOwner
                || !existing.leaseExpiresAt
                || existing.leaseExpiresAt < now
                || existing.leaseOwner === workerId;

            if (!canAcquire) {
                return null;
            }

            const leaseExpiresAt = new Date(now.getTime() + leaseMs);
            const next: LeaseDoc = {
                _id: taskId,
                leaseOwner: workerId,
                leaseExpiresAt,
                executionRunId: runId,
                executionStartedAt: now,
                executionEventSequence: 0,
            };
            docs.set(taskId, next);
            return next;
        },
    };
}

test("only one worker acquires lease for same task", async () => {
    const store = createLeaseStore();
    const taskId = "task-1";
    const leaseMs = 30_000;

    const [first, second] = await Promise.all([
        store.acquire(taskId, "worker-a", "run-a", leaseMs),
        store.acquire(taskId, "worker-b", "run-b", leaseMs),
    ]);

    const winners = [first, second].filter(Boolean);
    assert.equal(winners.length, 1);
});

test("same worker can refresh its own lease", async () => {
    const store = createLeaseStore();
    const taskId = "task-2";

    const first = await store.acquire(taskId, "worker-a", "run-a", 30_000);
    const second = await store.acquire(taskId, "worker-a", "run-a-refresh", 30_000);

    assert.ok(first);
    assert.ok(second);
    assert.equal(second?.leaseOwner, "worker-a");
    assert.equal(second?.executionRunId, "run-a-refresh");
});

test("expired lease is reclaimable by another worker", async () => {
    const store = createLeaseStore();
    const taskId = "task-3";

    const first = await store.acquire(taskId, "worker-a", "run-a", 1);
    assert.ok(first);

    store.docs.set(taskId, {
        ...first!,
        leaseExpiresAt: new Date(Date.now() - 1_000),
    });

    const second = await store.acquire(taskId, "worker-b", "run-b", 30_000);
    assert.ok(second);
    assert.equal(second?.leaseOwner, "worker-b");
});
