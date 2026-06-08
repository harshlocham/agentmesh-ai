import "./test-env.js";
import assert from "node:assert/strict";
import test from "node:test";
import {
    assertExecutionLeaseCompleted,
    ExecutionLeaseBusyError,
} from "../services/lease.service.js";

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

test("lease-busy execution result is surfaced as retryable worker failure", () => {
    assert.throws(
        () => assertExecutionLeaseCompleted("task-dispatch-3", { skipped: "lease_busy" }),
        ExecutionLeaseBusyError
    );
});

type MockOutboxEvent = {
    id: string;
    status: "pending" | "processing" | "completed" | "failed" | "dead_letter";
    attempts: number;
    availableAt: number;
    lockedBy: string | null;
    lockedAt: number | null;
    lastError: string | null;
};

const outboxById = new Map<string, MockOutboxEvent>();

function mockClaimOutboxEvent(eventId: string, workerId: string) {
    const event = outboxById.get(eventId);
    if (!event) {
        return null;
    }

    event.status = "processing";
    event.attempts += 1;
    event.lockedBy = workerId;
    event.lockedAt = Date.now();
    return event;
}

function mockDeferOutboxEvent(eventId: string, reason: string, delayMs: number) {
    const event = outboxById.get(eventId);
    if (!event) {
        return;
    }

    event.status = "failed";
    event.availableAt = Date.now() + delayMs;
    event.attempts = Math.max(0, event.attempts - 1);
    event.lockedBy = null;
    event.lockedAt = null;
    event.lastError = reason;
}

test("defer restores claim attempt increment and leaves event re-claimable", () => {
    const eventId = "outbox-event-1";
    outboxById.set(eventId, {
        id: eventId,
        status: "pending",
        attempts: 0,
        availableAt: Date.now(),
        lockedBy: null,
        lockedAt: null,
        lastError: null,
    });

    const claimed = mockClaimOutboxEvent(eventId, "worker-1");
    assert.ok(claimed);
    assert.equal(claimed.attempts, 1);
    assert.equal(claimed.status, "processing");

    mockDeferOutboxEvent(eventId, "Task execution lease busy for task task-dispatch-3", 1_000);

    const deferred = outboxById.get(eventId);
    assert.ok(deferred);
    assert.equal(deferred.attempts, 0);
    assert.equal(deferred.status, "failed");
    assert.equal(deferred.lockedBy, null);
    assert.equal(deferred.lockedAt, null);
    assert.ok(deferred.availableAt > Date.now());
    assert.notEqual(deferred.status, "completed");
    assert.notEqual(deferred.status, "dead_letter");
});
