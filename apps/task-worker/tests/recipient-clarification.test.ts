import "./test-env.js";
import assert from "node:assert/strict";
import test from "node:test";
import {
    applyClarificationSelection,
    type PendingResolution,
} from "../services/entity-resolution.service.js";
import { resolveToolParameters } from "../services/resolve-tool-params.js";

function makePending(reference: string, params: Record<string, unknown>): PendingResolution {
    return {
        toolName: "send_email",
        parametersSnapshot: { ...params },
        ambiguities: [{ reference, options: [] }],
    };
}

test("resolveToolParameters routes RFC 2606 example.com recipients to clarification", async () => {
    const result = await resolveToolParameters({
        toolName: "send_email",
        params: {
            to: ["harsh@example.com"],
            subject: "Welcome",
            body: "Hello",
        },
        userId: "user-1",
    });

    assert.equal(result.status, "clarification_required");
    if (result.status !== "clarification_required") return;
    assert.match(result.clarificationQuestion, /harsh/i);
    assert.match(result.clarificationQuestion, /placeholder|actual email|real email/i);
    assert.equal(result.pendingResolution.toolName, "send_email");
    assert.equal(result.pendingResolution.ambiguities[0]?.reference, "harsh@example.com");
    assert.deepEqual(result.pendingResolution.ambiguities[0]?.options, []);
    assert.deepEqual(result.pendingResolution.parametersSnapshot.to, ["harsh@example.com"]);
});

test("resolveToolParameters rejects reserved TLDs like *.test and *.invalid", async () => {
    for (const placeholder of ["user@something.test", "user@unknown.invalid", "user@host.localhost", "ops@my.local"]) {
        const result = await resolveToolParameters({
            toolName: "send_email",
            params: { to: placeholder, subject: "x", body: "x" },
            userId: "user-1",
        });
        assert.equal(result.status, "clarification_required", `Expected clarification for ${placeholder}`);
    }
});

test("resolveToolParameters rejects common placeholder domains (domain.com, yourcompany.com)", async () => {
    for (const placeholder of ["someone@domain.com", "ceo@yourcompany.com", "alice@placeholder.com"]) {
        const result = await resolveToolParameters({
            toolName: "send_email",
            params: { to: placeholder, subject: "x", body: "x" },
            userId: "user-1",
        });
        assert.equal(result.status, "clarification_required", `Expected clarification for ${placeholder}`);
    }
});

test("resolveToolParameters short-circuits on the FIRST placeholder recipient even in a mixed list", async () => {
    const result = await resolveToolParameters({
        toolName: "send_email",
        params: { to: ["harsh@example.com", "real@acme.com"], subject: "x", body: "x" },
        userId: "user-1",
    });
    assert.equal(result.status, "clarification_required");
    if (result.status !== "clarification_required") return;
    assert.equal(result.pendingResolution.ambiguities[0]?.reference, "harsh@example.com");
});

test("resolveToolParameters is a no-op for non-send_email tools", async () => {
    const result = await resolveToolParameters({
        toolName: "create_github_issue",
        params: { title: "x", body: "y" },
    });
    assert.equal(result.status, "resolved");
});

test("applyClarificationSelection accepts a free-form email reply when options are empty", () => {
    const pending = makePending("harsh@example.com", { to: ["harsh@example.com"] });
    const selection = applyClarificationSelection(pending, "harsh@gmail.com");
    assert.equal(selection.success, true);
    if (!selection.success) return;
    assert.equal(selection.selectedEmail, "harsh@gmail.com");
    assert.equal(selection.selectedName, "harsh@example.com");
});

test("applyClarificationSelection rejects a non-email free-form reply with empty options", () => {
    const pending = makePending("harsh@example.com", { to: ["harsh@example.com"] });
    const selection = applyClarificationSelection(pending, "not an email");
    assert.equal(selection.success, false);
    if (selection.success) return;
    assert.match(selection.error, /valid email address/i);
});

test("applyClarificationSelection still treats numeric replies as literal text when options are empty", () => {
    // Should NOT silently pick options[0]; with no options there is nothing to index.
    const pending = makePending("harsh@example.com", { to: ["harsh@example.com"] });
    const selection = applyClarificationSelection(pending, "1");
    assert.equal(selection.success, false);
});

test("applyClarificationSelection still works with predefined options (index match)", () => {
    const pending: PendingResolution = {
        toolName: "send_email",
        parametersSnapshot: { to: ["harsh"] },
        ambiguities: [
            {
                reference: "harsh",
                options: [
                    { name: "Harsh Singh", email: "harsh.singh@acme.com" },
                    { name: "Harsh Patel", email: "harsh.patel@acme.com" },
                ],
            },
        ],
    };
    const selection = applyClarificationSelection(pending, "2");
    assert.equal(selection.success, true);
    if (!selection.success) return;
    assert.equal(selection.selectedEmail, "harsh.patel@acme.com");
});

test("applyClarificationSelection returns error when no ambiguity entry exists", () => {
    const pending: PendingResolution = {
        toolName: "send_email",
        parametersSnapshot: {},
        ambiguities: [],
    };
    const selection = applyClarificationSelection(pending, "harsh@gmail.com");
    assert.equal(selection.success, false);
});
