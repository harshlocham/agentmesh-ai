import "./test-env.js";
import assert from "node:assert/strict";
import test from "node:test";
import { classifyExecutionError } from "../services/retry-classifier.js";

test("classifyExecutionError marks LLM failures as transient", () => {
    const decision = classifyExecutionError(new Error("LLM_ERROR: provider timeout"), 1);
    assert.equal(decision.retryable, true);
    assert.equal(decision.category, "transient_llm");
    assert.ok(decision.delayMs > 0);
});

test("classifyExecutionError marks abort/timeout as tool_timeout", () => {
    const decision = classifyExecutionError(new Error("The operation was aborted"), 2);
    assert.equal(decision.retryable, true);
    assert.equal(decision.category, "tool_timeout");
});

test("classifyExecutionError marks validation errors as non-retryable", () => {
    const decision = classifyExecutionError(new Error("Zod validation failed for parameters"), 0);
    assert.equal(decision.retryable, false);
    assert.equal(decision.category, "validation");
});

test("classifyExecutionError marks permanent tool rejection", () => {
    const decision = classifyExecutionError(new Error("Tool rejected request with status 403 forbidden"), 0);
    assert.equal(decision.retryable, false);
    assert.equal(decision.category, "permanent_tool_rejection");
});
