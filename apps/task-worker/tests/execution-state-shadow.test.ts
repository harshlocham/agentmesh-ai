import "./test-env.js";
import assert from "node:assert/strict";
import test from "node:test";
import type { ExecutionState } from "@chat/types";
import {
    appendShadowHistory,
    createQueuedShadowState,
    isExecutionState,
    reduceShadowExecutionEvent,
    resolveCurrentShadowState,
    shouldResetShadowRunState,
} from "../services/execution-state-shadow.js";

const queued: ExecutionState = {
    kind: "queued",
    queuedAt: "2026-05-31T00:00:00.000Z",
};

test("shadow reducer returns next state and history entry for legal transitions", () => {
    const result = reduceShadowExecutionEvent({
        current: queued,
        event: { type: "POLICY_EVALUATE" },
        workerId: "worker-1",
        at: new Date("2026-05-31T00:01:00.000Z"),
    });

    assert.equal(result.ok, true);
    assert.equal(result.from.kind, "queued");
    assert.equal(result.to.kind, "policy_evaluating");
    assert.equal(result.historyEntry.from.kind, "queued");
    assert.equal(result.historyEntry.to.kind, "policy_evaluating");
    assert.equal(result.historyEntry.event.type, "POLICY_EVALUATE");
    assert.equal(result.historyEntry.at, "2026-05-31T00:01:00.000Z");
    assert.equal(result.historyEntry.workerId, "worker-1");
    assert.equal(result.historyEntry.shadowError, undefined);
});

test("shadow reducer captures illegal transitions instead of throwing", () => {
    const result = reduceShadowExecutionEvent({
        current: queued,
        event: { type: "TOOL_OBSERVED" },
        workerId: "worker-1",
    });

    assert.equal(result.ok, false);
    assert.equal(result.from.kind, "queued");
    assert.equal(result.to.kind, "queued");
    assert.equal(result.historyEntry.from.kind, "queued");
    assert.equal(result.historyEntry.to.kind, "queued");
    assert.equal(result.historyEntry.event.type, "TOOL_OBSERVED");
    assert.match(result.historyEntry.shadowError?.message ?? "", /Invalid execution transition/);
});

test("shadow current-state resolver defaults missing values to queued", () => {
    const resolved = resolveCurrentShadowState(null, new Date("2026-05-31T00:02:00.000Z"));
    assert.deepEqual(resolved, {
        kind: "queued",
        queuedAt: "2026-05-31T00:02:00.000Z",
    });
});

test("shadow state validator only accepts known execution state kinds", () => {
    assert.equal(isExecutionState(createQueuedShadowState()), true);
    assert.equal(isExecutionState({ kind: "made_up" }), false);
    assert.equal(isExecutionState(null), false);
    assert.equal(isExecutionState("queued"), false);
});

test("shadow run reset only applies to missing or terminal states", () => {
    assert.equal(shouldResetShadowRunState(null), true);
    assert.equal(shouldResetShadowRunState({ kind: "failed", finishedAt: "now", reason: "x", lastError: "x" }), true);
    assert.equal(shouldResetShadowRunState({ kind: "succeeded", finishedAt: "now", runId: "run-1", result: { confidence: 1, summary: "ok", evidence: null } }), true);
    assert.equal(shouldResetShadowRunState({ kind: "paused", reason: "need input" }), false);
    assert.equal(shouldResetShadowRunState({ kind: "ready_to_execute", runId: "run-1", workerId: "worker-1", leaseExpiresAt: "soon" }), false);
});

test("shadow history append trims to the configured limit", () => {
    const entry = reduceShadowExecutionEvent({
        current: queued,
        event: { type: "POLICY_EVALUATE" },
    }).historyEntry;
    const history = Array.from({ length: 5 }, (_, index) => ({
        ...entry,
        at: `2026-05-31T00:00:0${index}.000Z`,
    }));

    const trimmed = appendShadowHistory(history, entry, 3);
    assert.equal(trimmed.length, 3);
    assert.deepEqual(trimmed.map((item) => item.at), [
        "2026-05-31T00:00:03.000Z",
        "2026-05-31T00:00:04.000Z",
        entry.at,
    ]);
});
