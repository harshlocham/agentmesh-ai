import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { AgentRunner } from "../services/agent-runner.js";
import type { Tool } from "../services/tools/tool-registry.js";
import ToolRegistry from "../services/tools/tool-registry.js";

type MockLlmPayload = {
    toolName: string;
    arguments: Record<string, unknown>;
    confidence?: number;
    reasoning?: string;
    noAction?: boolean;
    needsClarification?: boolean;
    clarificationQuestion?: string | null;
};

let currentLlmPayloads: Array<MockLlmPayload> | null = null;
let currentLlmIndex = 0;

type MockTask = {
    _id: { toString(): string };
    conversationId: { toString(): string };
    title: string;
    description: string;
    status: string;
    lifecycleState?: "planning" | "ready" | "executing" | "waiting_for_approval" | "blocked" | "retry_scheduled" | "paused" | "completed" | "failed";
    sourceMessageIds?: Array<{ toString(): string }>;
    retryCount?: number;
    maxRetries?: number;
    currentStepId?: string | null;
    iterationCount?: number;
    blockedReason?: string | null;
    pausedReason?: string | null;
    progress?: number;
    checkpoints?: Array<{ step: string; status: string; timestamp: string }>;
    executionHistory?: {
        attempts: number;
        failures: number;
        results: Array<Record<string, unknown>>;
    };
    result?: Record<string, unknown>;
    version: number;
    updatedBy: null | string;
    save: () => Promise<void>;
};

type PlanStep = {
    stepId: string;
    title: string;
    description: string;
    kind: "tool_call" | "decision" | "approval" | "notification" | "validation";
    state: "ready" | "running" | "waiting_for_dependency" | "waiting_for_approval" | "retry_scheduled" | "blocked" | "completed" | "failed" | "skipped";
    order: number;
    dependencies: string[];
    fallbackPolicy: "dependency_preserving" | "immediate_execution";
    overrideDependencies: boolean;
    fallback: Array<{ stepId: string; reason: string }>;
    successCriteria: string[];
    toolCandidates: Array<{ toolName: string; confidence: number; riskLevel: "low" | "medium" | "high" }>;
    selectedToolName?: string | null;
    input?: Record<string, unknown>;
    output?: Record<string, unknown>;
    attempts: number;
    maxAttempts: number;
    lastError?: string | null;
    startedAt?: Date | string | null;
    completedAt?: Date | string | null;
};

type PlanDoc = {
    taskId: { toString(): string };
    status: "draft" | "approved" | "active" | "completed" | "failed" | "cancelled";
    steps: PlanStep[];
    activeStepId?: string | null;
};

class QueueTool implements Tool {
    public readonly inputSchema = z.object({}).passthrough();
    private readonly outputs: Array<{ summary: string; adapterSuccess: boolean; evidence: unknown; error?: string }>;
    readonly calls: Array<{ name: string; input: Record<string, unknown> }> = [];

    constructor(
        public readonly name: string,
        public readonly description: string,
        outputs: Array<{ summary: string; adapterSuccess: boolean; evidence: unknown; error?: string }>
    ) {
        this.outputs = [...outputs];
    }

    async execute(input: Record<string, unknown>) {
        this.calls.push({ name: this.name, input });
        const next = this.outputs.shift();
        if (!next) {
            return {
                summary: `${this.name} default success`,
                adapterSuccess: true,
                evidence: { default: true },
            };
        }
        return next;
    }
}

function responsePayload(toolName: string, args: Record<string, unknown>, reasoning = "test decision") {
    const text = JSON.stringify({
        tool: toolName,
        confidence: 0.9,
        parameters: args,
        reasoning,
        noAction: false,
        needsClarification: false,
        clarificationQuestion: null,
    });

    return {
        output_text: text,
        output: [{ type: "message", content: [{ type: "output_text", text }] }],
    };
}

function createLlmRequestFn() {
    return async () => {
        const next = currentLlmPayloads?.[currentLlmIndex] ?? currentLlmPayloads?.[currentLlmPayloads.length - 1] ?? { toolName: "none", arguments: {} };
        currentLlmIndex += 1;

        const text = JSON.stringify({
            tool: next.toolName === "none" ? null : next.toolName,
            confidence: next.confidence ?? 0.9,
            parameters: next.arguments,
            reasoning: next.reasoning ?? "test decision",
            noAction: next.noAction ?? next.toolName === "none",
            needsClarification: next.needsClarification ?? false,
            clarificationQuestion: next.clarificationQuestion ?? null,
        });

        return {
            output_text: text,
            output: [{ type: "message", content: [{ type: "output_text", text }] }],
        };
    };
}

function createMockTask(): MockTask {
    const task: MockTask = {
        _id: { toString: () => "task-1" },
        conversationId: { toString: () => "conv-1" },
        title: "Persistent loop task",
        description: "Run persistent step-based agent",
        status: "pending",
        lifecycleState: "ready",
        sourceMessageIds: [],
        retryCount: 0,
        maxRetries: 2,
        currentStepId: null,
        iterationCount: 0,
        blockedReason: null,
        pausedReason: null,
        progress: 0,
        checkpoints: [],
        executionHistory: { attempts: 0, failures: 0, results: [] },
        result: undefined,
        version: 1,
        updatedBy: null,
        save: async () => {
            task.version += 1;
        },
    };

    return task;
}

function createPlan(withFallback: boolean, fallbackPolicy: "dependency_preserving" | "immediate_execution" = "dependency_preserving"): PlanDoc {
    const steps: PlanStep[] = [
        {
            stepId: "step-1",
            title: "Primary step",
            description: "Use tool",
            kind: "tool_call",
            state: "ready",
            order: 1,
            dependencies: [],
            fallbackPolicy: "dependency_preserving",
            overrideDependencies: false,
            fallback: withFallback ? [{ stepId: "step-2", reason: "Primary failed" }] : [],
            successCriteria: ["tool succeeds"],
            toolCandidates: [{ toolName: "send_email", confidence: 0.9, riskLevel: "low" }],
            selectedToolName: null,
            input: {},
            output: {},
            attempts: 0,
            maxAttempts: 2,
            lastError: null,
            startedAt: null,
            completedAt: null,
        },
    ];

    if (withFallback) {
        steps.push({
            stepId: "step-2",
            title: "Fallback step",
            description: "fallback",
            kind: "tool_call",
            state: "waiting_for_dependency",
            order: 2,
            dependencies: ["step-1"],
            fallbackPolicy,
            overrideDependencies: false,
            fallback: [],
            successCriteria: ["fallback succeeds"],
            toolCandidates: [{ toolName: "create_github_issue", confidence: 0.8, riskLevel: "medium" }],
            selectedToolName: null,
            input: {},
            output: {},
            attempts: 0,
            maxAttempts: 1,
            lastError: null,
            startedAt: null,
            completedAt: null,
        });
    }

    return {
        taskId: { toString: () => "task-1" },
        status: "active",
        activeStepId: "step-1",
        steps,
    };
}

function createRunnerHarness(options?: {
    withFallbackPlan?: boolean;
    fallbackPolicy?: "dependency_preserving" | "immediate_execution";
    sendEmailOutputs?: Array<{ summary: string; adapterSuccess: boolean; evidence: unknown; error?: string }>;
    createIssueOutputs?: Array<{ summary: string; adapterSuccess: boolean; evidence: unknown; error?: string }>;
    useProviderLlm?: boolean;
    usePlanner?: boolean;
    planFactory?: () => PlanDoc;
}) {
    const task = createMockTask();
    let plan = options?.usePlanner ? null : createPlan(Boolean(options?.withFallbackPlan), options?.fallbackPolicy ?? "dependency_preserving");
    const stepPatches: Array<{ stepId: string; patch: Record<string, unknown> }> = [];
    let reflectionCalls = 0;
    let memoryCalls = 0;
    let acquireCalls = 0;
    let heartbeatCalls = 0;
    let releaseCalls = 0;

    const sendEmailTool = new QueueTool("send_email", "Send email", options?.sendEmailOutputs ?? [
        { summary: "mail sent", adapterSuccess: true, evidence: { responseStatus: 200, responseBody: { id: "x" } } },
    ]);
    const createIssueTool = new QueueTool("create_github_issue", "Create issue", options?.createIssueOutputs ?? [
        { summary: "issue created", adapterSuccess: true, evidence: { issue: { html_url: "http://x", number: 1 }, responseStatus: 201 } },
    ]);

    const registry = new ToolRegistry();
    registry.register(sendEmailTool);
    registry.register(createIssueTool);

    const runner = new AgentRunner({
        persistentLoopEnabled: true,
        workerId: "worker-test",
        taskModel: {
            findById: async (id: string) => (id === "task-1" ? (task as any) : null),
        },
        toolRegistry: registry,
        taskSuccessRegistry: {
            validate: (_actionType: string, _task: unknown, result: { adapterSuccess: boolean }) => ({
                validator: "test-validator",
                passed: result.adapterSuccess,
                checks: [{ name: "adapter-success", passed: result.adapterSuccess, details: null }],
                evaluatedAt: new Date().toISOString(),
            }),
        } as any,
        getLatestExecutionTaskAction: async () => ({
            taskId: { toString: () => "task-1" },
            conversationId: { toString: () => "conv-1" },
            actionType: "none",
            toolName: "none",
            parameters: {},
            messageId: null,
            executionState: null,
        }),
        acquireTaskLeaseFn: async () => {
            acquireCalls += 1;
            return { _id: "lease" } as any;
        },
        heartbeatTaskLeaseFn: async () => {
            heartbeatCalls += 1;
            return { _id: "lease" } as any;
        },
        releaseTaskLeaseFn: async () => {
            releaseCalls += 1;
            return { acknowledged: true } as any;
        },
        retrieveMemoryFn: async () => {
            memoryCalls += 1;
            return {
                shortTerm: [{ summary: "recent failure avoided", successImpact: 0.2 }],
                longTerm: [{ toolName: "send_email", successImpact: 0.8 }],
            } as any;
        },
        generateAndStoreReflectionFn: async () => {
            reflectionCalls += 1;
            return { _id: "reflection-1" } as any;
        },
        assertTransitionFn: () => {
            // no-op for deterministic tests
        },
        llmRequestFn: options?.useProviderLlm ? undefined : createLlmRequestFn(),
        getTaskPlanFn: async () => (plan as any),
        createOrRefreshTaskPlanFn: async () => {
            plan = options?.planFactory?.() ?? createPlan(Boolean(options?.withFallbackPlan), options?.fallbackPolicy ?? "dependency_preserving");
            return plan as any;
        },
        updatePlanStepStateFn: async (_taskId, stepId, patch) => {
            stepPatches.push({ stepId, patch: patch as Record<string, unknown> });
            const step = plan?.steps.find((entry) => entry.stepId === stepId);
            if (!step) return;
            Object.assign(step, patch);

            // unlock step-2 once step-1 fails
            if (stepId === "step-1" && patch.state === "failed" && plan) {
                const fallback = plan.steps.find((entry) => entry.stepId === "step-2");
                if (fallback) {
                    fallback.state = "ready";
                }
            }
        },
    });

    return {
        runner,
        task,
        get plan() { return plan as PlanDoc; },
        stepPatches,
        sendEmailTool,
        createIssueTool,
        stats: {
            get reflectionCalls() { return reflectionCalls; },
            get memoryCalls() { return memoryCalls; },
            get acquireCalls() { return acquireCalls; },
            get heartbeatCalls() { return heartbeatCalls; },
            get releaseCalls() { return releaseCalls; },
        },
    };
}

function withMockedFetch(payloads: Array<MockLlmPayload>, fn: () => Promise<void>) {
    const originalFetch = global.fetch;
    let index = 0;
    const previousPayloads = currentLlmPayloads;
    const previousIndex = currentLlmIndex;
    currentLlmPayloads = payloads;
    currentLlmIndex = 0;

    global.fetch = (async (input: URL | RequestInfo) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

        if (url.includes("/responses")) {
            const next = payloads[index] ?? payloads[payloads.length - 1];
            index += 1;
            return new Response(JSON.stringify({
                ...responsePayload(next.toolName, next.arguments),
            }), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            });
        }

        if (url.includes("/internal/task-updated")) {
            return new Response(JSON.stringify({ ok: true }), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            });
        }

        return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
        });
    }) as typeof fetch;

    return fn().finally(() => {
        global.fetch = originalFetch;
        currentLlmPayloads = previousPayloads;
        currentLlmIndex = previousIndex;
    });
}

function restoreEnvVar(key: string, value: string | undefined) {
    if (value === undefined) {
        delete process.env[key];
        return;
    }

    process.env[key] = value;
}

test("persistent loop: acquires lease, heartbeats, and releases lease", async () => {
    const harness = createRunnerHarness();

    await withMockedFetch(
        [{ toolName: "send_email", arguments: { to: ["team@example.com"] } }],
        async () => {
            const result = await harness.runner.runTask("task-1");
            assert.equal(result.completed, true);
        }
    );

    assert.equal(harness.stats.acquireCalls, 1);
    assert.ok(harness.stats.heartbeatCalls >= 1);
    assert.equal(harness.stats.releaseCalls, 1);
});

test("persistent loop: tool execution and verification exercise the runtime", async () => {
    const harness = createRunnerHarness({
        sendEmailOutputs: [
            {
                summary: "mail sent",
                adapterSuccess: true,
                evidence: { responseStatus: 200, responseBody: { id: "email-1" } },
            },
        ],
    });

    await withMockedFetch(
        [{ toolName: "send_email", arguments: { to: ["team@example.com"], subject: "Status update" } }],
        async () => {
            const outcome = await harness.runner.runTask("task-1");

            assert.equal(outcome.completed, true);
        }
    );

    assert.ok(harness.stats.acquireCalls >= 1);
    assert.ok(harness.stats.releaseCalls >= 1);
    assert.equal(harness.sendEmailTool.calls.length, 1);
    assert.equal(harness.sendEmailTool.calls[0]?.name, "send_email");
});

test("persistent loop: uses memory + ranked tool decision", async () => {
    const harness = createRunnerHarness();

    await withMockedFetch(
        [{ toolName: "send_email", arguments: { to: ["team@example.com"], subject: "Hi" } }],
        async () => {
            const result = await harness.runner.runTask("task-1");
            assert.equal(result.completed, true);
        }
    );

    assert.ok(harness.stats.memoryCalls >= 1);
    assert.equal(harness.sendEmailTool.calls.length >= 1, true);
});

test("persistent loop: step-level failure triggers fallback step", async () => {
    const harness = createRunnerHarness({
        withFallbackPlan: true,
        fallbackPolicy: "dependency_preserving",
        sendEmailOutputs: [
            { summary: "permanent fail", adapterSuccess: false, evidence: { responseStatus: 400 }, error: "invalid recipient" },
        ],
        createIssueOutputs: [
            { summary: "fallback ok", adapterSuccess: true, evidence: { issue: { html_url: "http://x", number: 1 }, responseStatus: 201 } },
        ],
    });

    await withMockedFetch(
        [
            { toolName: "send_email", arguments: { to: ["team@example.com"] } },
            { toolName: "create_github_issue", arguments: { title: "fallback" } },
        ],
        async () => {
            const result = await harness.runner.runTask("task-1");
            assert.equal(result.completed, false);
        }
    );

    const failedPrimary = harness.stepPatches.some((entry) => entry.stepId === "step-1" && entry.patch.state === "failed");
    const promotedFallback = harness.plan.steps.some((entry) => entry.stepId === "step-2" && entry.state === "ready");
    const fallbackNotExecuted = harness.createIssueTool.calls.length === 0;

    assert.equal(failedPrimary, true);
    assert.equal(promotedFallback, true);
    assert.equal(fallbackNotExecuted, true);
});

test("persistent loop: immediate fallback remains blocked when dependency fails", async () => {
    const harness = createRunnerHarness({
        withFallbackPlan: true,
        fallbackPolicy: "immediate_execution",
        sendEmailOutputs: [
            { summary: "permanent fail", adapterSuccess: false, evidence: { responseStatus: 400 }, error: "invalid recipient" },
        ],
        createIssueOutputs: [
            { summary: "fallback ok", adapterSuccess: true, evidence: { issue: { html_url: "http://x", number: 1 }, responseStatus: 201 } },
        ],
    });

    await withMockedFetch(
        [
            { toolName: "send_email", arguments: { to: ["team@example.com"] } },
            { toolName: "create_github_issue", arguments: { title: "fallback" } },
        ],
        async () => {
            const result = await harness.runner.runTask("task-1");
            assert.equal(result.completed, false);
        }
    );

    const completedFallback = harness.stepPatches.some((entry) => entry.stepId === "step-2" && entry.patch.state === "completed");
    const fallbackExecuted = harness.createIssueTool.calls.length >= 1;

    assert.equal(completedFallback, false);
    assert.equal(fallbackExecuted, false);
});

test("persistent loop: writes reflection on terminal state", async () => {
    const harness = createRunnerHarness();

    await withMockedFetch(
        [{ toolName: "send_email", arguments: { to: ["team@example.com"], subject: "done" } }],
        async () => {
            await harness.runner.runTask("task-1");
        }
    );

    assert.equal(harness.stats.reflectionCalls, 1);
});

test("persistent loop: self-heals a failed tool execution before retry scheduling", async () => {
    const harness = createRunnerHarness({
        sendEmailOutputs: [
            { summary: "smtp failed", adapterSuccess: false, evidence: { responseStatus: 500 }, error: "smtp unavailable" },
            { summary: "smtp recovered", adapterSuccess: true, evidence: { responseStatus: 200, responseBody: { id: "msg-2" } } },
        ],
    });

    await withMockedFetch(
        [
            { toolName: "send_email", arguments: { to: ["team@example.com"], subject: "First attempt" } },
            { toolName: "send_email", arguments: { to: ["team@example.com"], subject: "Corrected attempt" } },
        ],
        async () => {
            const result = await harness.runner.runTask("task-1");
            assert.equal(result.completed, true);
        }
    );

    assert.equal(harness.sendEmailTool.calls.length, 2);
    assert.equal(harness.sendEmailTool.calls[1]?.input.subject, "Corrected attempt");
});
