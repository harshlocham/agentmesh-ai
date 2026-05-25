import assert from "node:assert/strict";
import test from "node:test";
import { __testInternals } from "../services/agent-runner.js";

test("resolveGetLatestExecutionTaskAction resolves direct named export", async () => {
    const expected = { actionType: "send_email" };
    const fn = async () => expected;

    const resolved = __testInternals.resolveGetLatestExecutionTaskAction({
        getLatestExecutionTaskAction: fn,
    });

    assert.equal(resolved, fn);
    assert.deepEqual(await resolved("task-1"), expected);
});

test("resolveGetLatestExecutionTaskAction resolves default-wrapped export", async () => {
    const expected = { actionType: "schedule_meeting" };
    const fn = async () => expected;

    const resolved = __testInternals.resolveGetLatestExecutionTaskAction({
        default: {
            getLatestExecutionTaskAction: fn,
        },
    });

    assert.equal(resolved, fn);
    assert.deepEqual(await resolved("task-2"), expected);
});

test("resolveGetLatestExecutionTaskAction throws when export is missing", () => {
    assert.throws(
        () => __testInternals.resolveGetLatestExecutionTaskAction({ default: {} }),
        /Task repository exports are invalid/
    );
});
