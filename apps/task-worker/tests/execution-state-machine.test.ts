import "./test-env.js";
import assert from "node:assert/strict";
import test from "node:test";
import {
    assertExecutionTransition,
    canTransitionExecutionState,
    InvalidExecutionTransitionError,
    reduceExecutionState,
} from "../services/execution-state-machine.js";
import {
    deriveLegacyLifecycleState,
    deriveLegacyTaskStatus,
    type ExecutionState,
} from "@chat/types";

const queued: ExecutionState = {
    kind: "queued",
    queuedAt: "2026-05-29T00:00:00.000Z",
};

const lease = {
    runId: "run-task-1",
    workerId: "worker-1",
    leaseExpiresAt: "2026-05-29T00:05:00.000Z",
};

test("execution FSM follows the happy path through finalize", () => {
    const policy = reduceExecutionState(queued, { type: "POLICY_EVALUATE" });
    assert.equal(policy.kind, "policy_evaluating");

    const planning = reduceExecutionState(policy, { type: "LEASE_ACQUIRED", ...lease });
    assert.equal(planning.kind, "planning");

    const ready = reduceExecutionState(planning, { type: "PLAN_READY" });
    assert.equal(ready.kind, "ready_to_execute");

    const reasoning = reduceExecutionState(ready, { type: "ITERATION_START", iteration: 1 });
    assert.equal(reasoning.kind, "reasoning");

    const executing = reduceExecutionState(reasoning, {
        type: "TOOL_STARTED",
        stepId: "step-1",
        toolName: "send_email",
        attempt: 1,
        idempotencyKey: "idem-1",
    });
    assert.equal(executing.kind, "tool_executing");

    const observing = reduceExecutionState(executing, { type: "TOOL_OBSERVED" });
    assert.equal(observing.kind, "observing");

    const verifying = reduceExecutionState(observing, { type: "TOOL_VERIFIED" });
    assert.equal(verifying.kind, "verifying");

    const stepComplete = reduceExecutionState(verifying, { type: "STEP_COMPLETED" });
    assert.equal(stepComplete.kind, "step_complete");

    const succeeded = reduceExecutionState(stepComplete, {
        type: "GOAL_ACHIEVED",
        runId: lease.runId,
        finishedAt: "2026-05-29T00:01:00.000Z",
        result: {
            confidence: 0.95,
            summary: "Task completed.",
            evidence: { ok: true },
        },
    });
    assert.equal(succeeded.kind, "succeeded");
    assert.equal(deriveLegacyLifecycleState(succeeded), "completed");
    assert.equal(deriveLegacyTaskStatus(succeeded), "completed");
});

test("execution FSM rejects impossible phase ordering", () => {
    assert.equal(canTransitionExecutionState("reasoning", "verifying"), false);
    assert.throws(
        () => reduceExecutionState({ kind: "reasoning", iteration: 1, ...lease }, { type: "TOOL_VERIFIED" }),
        InvalidExecutionTransitionError
    );
});

test("execution FSM supports approval pending and approval grant", () => {
    const policy = reduceExecutionState(queued, { type: "POLICY_EVALUATE" });
    const awaitingApproval = reduceExecutionState(policy, {
        type: "POLICY_APPROVAL_REQUIRED",
        actionType: "send_email",
        requestedAt: "2026-05-29T00:00:01.000Z",
    });

    assert.equal(awaitingApproval.kind, "awaiting_approval");
    assert.equal(deriveLegacyLifecycleState(awaitingApproval), "waiting_for_approval");
    assert.equal(deriveLegacyTaskStatus(awaitingApproval), "partial");

    const planning = reduceExecutionState(awaitingApproval, {
        type: "APPROVAL_GRANTED",
        ...lease,
    });
    assert.equal(planning.kind, "planning");
});

test("execution FSM supports retry scheduling and retry due", () => {
    const retryScheduled = reduceExecutionState(
        { kind: "tool_executing", iteration: 1, stepId: "step-1", toolName: "send_email", attempt: 1, idempotencyKey: "idem-1", ...lease },
        {
            type: "ERROR_OCCURRED",
            reason: "provider timeout",
            retryable: true,
            category: "tool_timeout",
            retryCount: 1,
            maxRetries: 2,
            nextRetryAt: "2026-05-29T00:02:00.000Z",
            finishedAt: "2026-05-29T00:01:00.000Z",
        }
    );

    assert.equal(retryScheduled.kind, "retry_scheduled");
    assert.equal(deriveLegacyLifecycleState(retryScheduled), "retry_scheduled");
    assert.equal(deriveLegacyTaskStatus(retryScheduled), "partial");

    const queuedAgain = reduceExecutionState(retryScheduled, {
        type: "RETRY_DUE",
        queuedAt: "2026-05-29T00:02:00.000Z",
    });
    assert.equal(queuedAgain.kind, "queued");
});

test("execution FSM supports cancellation from non-terminal states only", () => {
    const cancelling = reduceExecutionState(
        { kind: "observing", iteration: 1, stepId: "step-1", toolName: "send_email", ...lease },
        {
            type: "CANCEL_REQUESTED",
            initiatedBy: "user",
            reason: "User cancelled task.",
            requestedAt: "2026-05-29T00:00:30.000Z",
        }
    );
    assert.equal(cancelling.kind, "cancelling");

    const cancelled = reduceExecutionState(cancelling, {
        type: "CANCEL_FINALIZED",
        reason: "User cancelled task.",
        cancelledAt: "2026-05-29T00:00:31.000Z",
    });
    assert.equal(cancelled.kind, "cancelled");
    assert.equal(deriveLegacyLifecycleState(cancelled), "failed");
    assert.equal(deriveLegacyTaskStatus(cancelled), "failed");

    assert.throws(
        () => assertExecutionTransition("succeeded", "cancelling", "CANCEL_REQUESTED"),
        InvalidExecutionTransitionError
    );
});

test("execution FSM converts exhausted retry to failed", () => {
    const failed = reduceExecutionState(
        { kind: "verifying", iteration: 1, stepId: "step-1", toolName: "send_email", ...lease },
        {
            type: "ERROR_OCCURRED",
            reason: "verification failed",
            retryable: true,
            category: "verification",
            retryCount: 3,
            maxRetries: 2,
            finishedAt: "2026-05-29T00:03:00.000Z",
        }
    );

    assert.equal(failed.kind, "failed");
    assert.equal(deriveLegacyLifecycleState(failed), "failed");
    assert.equal(deriveLegacyTaskStatus(failed), "failed");
});
