import "./test-env.js";
import assert from "node:assert/strict";
import test from "node:test";

type StoredEvent = {
    taskId: string;
    runId: string;
    sequence: number;
    type: string;
};

function createEventStore() {
    const events: StoredEvent[] = [];
    let sequence = 0;

    return {
        append(taskId: string, runId: string, type: string) {
            sequence += 1;
            events.push({ taskId, runId, sequence, type });
            return sequence;
        },
        getAfter(taskId: string, afterSequence: number, limit = 200) {
            return events
                .filter((event) => event.taskId === taskId && event.sequence > afterSequence)
                .sort((a, b) => a.sequence - b.sequence)
                .slice(0, limit);
        },
        events,
    };
}

test("execution events replay in sequence order", () => {
    const store = createEventStore();
    const taskId = "task-1";
    const runId = "run-1";

    store.append(taskId, runId, "execution_started");
    store.append(taskId, runId, "tool_selected");
    store.append(taskId, runId, "tool_started");
    store.append(taskId, runId, "execution_completed");

    const replay = store.getAfter(taskId, 1, 10);
    assert.equal(replay.length, 3);
    assert.deepEqual(replay.map((event) => event.sequence), [2, 3, 4]);
    assert.deepEqual(replay.map((event) => event.type), ["tool_selected", "tool_started", "execution_completed"]);
});

test("replay dedupe key prevents duplicate render keys", () => {
    const events = [
        { runId: "run-1", sequence: 1 },
        { runId: "run-1", sequence: 1 },
        { runId: "run-1", sequence: 2 },
    ];

    const unique = new Map<string, (typeof events)[number]>();
    for (const event of events) {
        unique.set(`${event.runId}:${event.sequence}`, event);
    }

    assert.equal(unique.size, 2);
});
