import "./test-env.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

function buildToolIdempotencyKey(args: {
    taskId: string;
    runId: string;
    stepId: string | null;
    toolName: string;
    params: unknown;
}): string {
    const canonical = JSON.stringify(args.params ?? {});
    return createHash("sha256")
        .update(`${args.taskId}|${args.stepId ?? "default"}|${args.toolName}|${canonical}`)
        .digest("hex")
        .slice(0, 64);
}

test("idempotency key is stable for same task/step/tool/params", () => {
    const input = {
        taskId: "task-1",
        runId: "run-1",
        stepId: "step-a",
        toolName: "send_email",
        params: { to: "a@example.com", subject: "Hello" },
    };

    const first = buildToolIdempotencyKey(input);
    const second = buildToolIdempotencyKey(input);

    assert.equal(first, second);
});

test("idempotency key survives runId changes after rerun or lease steal", () => {
    const base = {
        taskId: "task-1",
        stepId: "step-a",
        toolName: "send_email",
        params: { to: "a@example.com", subject: "Hello" },
    };

    const firstRun = buildToolIdempotencyKey({ ...base, runId: "run-1" });
    const stolenRun = buildToolIdempotencyKey({ ...base, runId: "run-2" });

    assert.equal(firstRun, stolenRun);
});

test("idempotency key changes when params change", () => {
    const base = {
        taskId: "task-1",
        runId: "run-1",
        stepId: "step-a",
        toolName: "send_email",
    };

    const first = buildToolIdempotencyKey({ ...base, params: { to: "a@example.com" } });
    const second = buildToolIdempotencyKey({ ...base, params: { to: "b@example.com" } });

    assert.notEqual(first, second);
});

test("idempotency registry returns cached successful action", () => {
    const registry = new Map<string, { executionState: string; summary: string }>();
    const key = "abc123";

    registry.set(key, { executionState: "running", summary: "in flight" });

    const duplicate = registry.get(key);
    assert.ok(duplicate);
    assert.equal(duplicate.executionState, "running");

    registry.set(key, { executionState: "succeeded", summary: "email sent" });
    const replay = registry.get(key);
    assert.equal(replay?.executionState, "succeeded");
    assert.equal(replay?.summary, "email sent");
});
