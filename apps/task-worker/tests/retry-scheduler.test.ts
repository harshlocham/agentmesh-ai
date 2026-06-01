import "./test-env.js";
import assert from "node:assert/strict";
import test from "node:test";

type RetryTask = {
    id: string;
    lifecycleState: string;
    nextRetryAt: number;
    retryCount: number;
    leaseOwner: string | null;
    leaseExpiresAt: number;
};

function createRetryStore() {
    const tasks = new Map<string, RetryTask>();
    const outbox: string[] = [];

    return {
        tasks,
        outbox,
        scheduleOnce(now: number) {
            const candidates = Array.from(tasks.values())
                .filter((task) =>
                    task.lifecycleState === "retry_scheduled"
                    && task.nextRetryAt <= now
                    && (!task.leaseOwner || task.leaseExpiresAt < now)
                )
                .sort((a, b) => a.nextRetryAt - b.nextRetryAt);

            const candidate = candidates[0];
            if (!candidate) {
                return 0;
            }

            if (candidate.lifecycleState !== "retry_scheduled") {
                return 0;
            }

            candidate.lifecycleState = "ready";
            const dedupeKey = `task.execution.requested:${candidate.id}:retry:${candidate.retryCount}`;
            if (outbox.includes(dedupeKey)) {
                return 0;
            }

            outbox.push(dedupeKey);
            return 1;
        },
    };
}

test("retry scheduler enqueues one outbox event per retry attempt", () => {
    const store = createRetryStore();
    store.tasks.set("task-1", {
        id: "task-1",
        lifecycleState: "retry_scheduled",
        nextRetryAt: Date.now() - 1,
        retryCount: 2,
        leaseOwner: null,
        leaseExpiresAt: 0,
    });

    const first = store.scheduleOnce(Date.now());
    const second = store.scheduleOnce(Date.now());

    assert.equal(first, 1);
    assert.equal(second, 0);
    assert.equal(store.outbox.length, 1);
    assert.equal(store.outbox[0], "task.execution.requested:task-1:retry:2");
});

test("retry scheduler does not double-enqueue same retry count", () => {
    const store = createRetryStore();
    store.tasks.set("task-2", {
        id: "task-2",
        lifecycleState: "retry_scheduled",
        nextRetryAt: Date.now() - 10,
        retryCount: 1,
        leaseOwner: null,
        leaseExpiresAt: 0,
    });

    store.scheduleOnce(Date.now());
    store.tasks.get("task-2")!.lifecycleState = "retry_scheduled";
    store.tasks.get("task-2")!.nextRetryAt = Date.now() - 5;

    const again = store.scheduleOnce(Date.now());
    assert.equal(again, 0);
    assert.equal(store.outbox.length, 1);
});
