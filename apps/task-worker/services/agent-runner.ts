import type { TaskCheckpoint, TaskExecutionActionType, TaskExecutionHistory, TaskExecutionUpdatedPayload, TaskResult, TaskUpdatedPayload, TaskValidationLog } from "@chat/types";
import { RetryManager } from "./retry-manager.js";
import * as taskRepo from "@chat/services/repositories/task.repo";
import * as taskModule from "@chat/db/models/Task";
import TaskPlanModel from "@chat/db/models/TaskPlan";
import ToolRegistry from "./tools/tool-registry.js";
import TaskSuccessRegistry, { createDefaultTaskSuccessRegistry } from "./task-success-registry.js";
import { CreateIssueTool } from "./tools/create-issue.tool.js";
import { ScheduleMeetingTool } from "./tools/schedule-meeting.tool.js";
import { SendEmailTool } from "./tools/send-email.tool.js";
import { createOrRefreshTaskPlan, getTaskPlan } from "./planner.js";
import { retrieveMemory } from "./memory-service.js";
import { generateAndStoreReflection } from "./reflection-service.js";
import { acquireTaskLease, heartbeatTaskLease, releaseTaskLease } from "./task-lease.js";
import { assertTransition } from "./task-state-machine.js";
import { rankTools, type ToolRankingInput } from "./tool-ranking.js";
import { collectPreviousStepOutputs, llmDecisionSchema, normalizeParams, resolveStepTemplates, type PreviousStepOutputs, validateToolParameters } from "./step-execution-utils.js";
import { createDefaultLLMProvider } from "./llm/index.js";
import { parseJsonText } from "./llm/response-parser.js";

const INTERNAL_SECRET_HEADER = "x-internal-secret";

type TaskModelLike = {
    findById: (id: string) => Promise<TaskDocumentLike | null>;
};

type ExecutionActionRecord = {
    taskId: string;
    conversationId: string;
    toolName: string;
    parameters: Record<string, unknown>;
    messageId: string | null;
    executionState: string | null;
    stepId?: string | null;
    attempt?: number;
    idempotencyKey?: string | null;
};

type TaskDocumentLike = {
    _id: { toString(): string };
    conversationId: { toString(): string };
    parentTaskId?: { toString(): string } | null;
    lifecycleState?: "planning" | "ready" | "executing" | "waiting_for_approval" | "blocked" | "retry_scheduled" | "paused" | "completed" | "failed";
    sourceMessageIds?: Array<{ toString(): string }>;
    title: string;
    description: string;
    status: string;
    subTasks?: Array<{ toString(): string }>;
    dependencyIds?: Array<{ toString(): string }>;
    retryCount?: number;
    maxRetries?: number;
    currentStepId?: string | null;
    iterationCount?: number;
    leaseOwner?: string | null;
    leaseExpiresAt?: Date | null;
    blockedReason?: string | null;
    pausedReason?: string | null;
    progress?: number;
    checkpoints?: TaskCheckpoint[];
    executionHistory?: TaskExecutionHistory;
    result?: TaskResult;
    version: number;
    updatedBy: null | string;
    save: () => Promise<void>;
};

type ActionExecutionResult = {
    summary: string;
    adapterSuccess: boolean;
    evidence: unknown;
    error?: string;
};

type VerificationOutcome = {
    success: boolean;
    confidence: number;
    validationLog?: TaskValidationLog;
};

type AvailableToolForDecision = {
    name: string;
    description: string;
    inputSchema: unknown;
};

type NextActionDecision = {
    toolName: string | null;
    confidence: number;
    toolInput: Record<string, unknown>;
    reasoning?: string;
    goalAchieved?: boolean;
    noAction?: boolean;
    needsClarification?: boolean;
    clarificationQuestion?: string;
};

type IterationContextEntry = {
    iteration: number;
    decision: {
        toolName: string | null;
        reasoning?: string;
        noAction?: boolean;
        needsClarification?: boolean;
    };
    result?: {
        summary: string;
        adapterSuccess: boolean;
        error?: string;
    };
};

type LoopContext = {
    task: TaskDocumentLike;
    action: ExecutionActionRecord;
    retryCount: number;
    maxRetries: number;
    attemptPayload: ExecutionActionRecord;
    observed: ActionExecutionResult | null;
    verification: VerificationOutcome | null;
};

type RunTaskOutcome = {
    completed: boolean;
    retryCount: number;
    maxRetries: number;
    result: ActionExecutionResult | null;
    verification: VerificationOutcome | null;
};

type ExecutionUpdateEmitter = (payload: TaskExecutionUpdatedPayload) => Promise<void> | void;

type PlanStepLike = {
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

type TaskPlanLike = {
    taskId: { toString(): string };
    status: "draft" | "approved" | "active" | "completed" | "failed" | "cancelled";
    steps: PlanStepLike[];
    activeStepId?: string | null;
};

type RetrieveMemoryFn = typeof retrieveMemory;
type GetTaskPlanFn = typeof getTaskPlan;
type CreateOrRefreshTaskPlanFn = typeof createOrRefreshTaskPlan;
type GenerateAndStoreReflectionFn = typeof generateAndStoreReflection;
type AcquireTaskLeaseFn = typeof acquireTaskLease;
type HeartbeatTaskLeaseFn = typeof heartbeatTaskLease;
type ReleaseTaskLeaseFn = typeof releaseTaskLease;
type AssertTransitionFn = typeof assertTransition;
type UpdatePlanStepStateFn = (taskId: string, stepId: string, patch: Partial<PlanStepLike>) => Promise<void>;

type LlmRequestFn = (request: { model: string; input: string }) => Promise<{ output_text?: string; output?: unknown }>;

type LatestExecutionTaskAction = {
    taskId: { toString(): string };
    conversationId: { toString(): string };
    actionType: string;
    toolName?: string | null;
    parameters?: Record<string, unknown> | null;
    messageId?: { toString(): string } | null;
    executionState?: string | null;
};

type GetLatestExecutionTaskAction = (taskId: string) => Promise<LatestExecutionTaskAction | null>;

type ExecutionHistoryDelta = {
    attempts?: number;
    failures?: number;
    appendResult?: {
        attempt: number;
        success: boolean;
        summary: string;
        error?: string;
        validationLog?: TaskValidationLog;
    };
};

function wait(ms: number) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

function waitForSignal(ms: number, signal?: AbortSignal) {
    if (!signal) {
        return wait(ms);
    }

    return new Promise<void>((resolve, reject) => {
        if (signal.aborted) {
            reject(new Error("Execution aborted."));
            return;
        }

        const handle = setTimeout(() => {
            cleanup();
            resolve();
        }, ms);

        const onAbort = () => {
            cleanup();
            reject(new Error("Execution aborted."));
        };

        const cleanup = () => {
            clearTimeout(handle);
            signal.removeEventListener("abort", onAbort);
        };

        signal.addEventListener("abort", onAbort, { once: true });
    });
}

function combineAbortSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
    const activeSignals = signals.filter(Boolean) as AbortSignal[];
    if (activeSignals.length === 0) {
        return undefined;
    }

    if (typeof AbortSignal.any === "function") {
        return AbortSignal.any(activeSignals);
    }

    const controller = new AbortController();
    for (const signal of activeSignals) {
        if (signal.aborted) {
            controller.abort();
            return controller.signal;
        }
        signal.addEventListener("abort", () => controller.abort(), { once: true });
    }

    return controller.signal;
}

function resolveTaskModel(moduleNs: unknown): TaskModelLike {
    const asRecord = moduleNs as Record<string, unknown>;
    const candidates: unknown[] = [
        moduleNs,
        asRecord?.default,
        (asRecord?.default as Record<string, unknown> | undefined)?.default,
        asRecord?.TaskModel,
        (asRecord?.default as Record<string, unknown> | undefined)?.TaskModel,
    ];

    for (const candidate of candidates) {
        if (candidate && typeof (candidate as { findById?: unknown }).findById === "function") {
            return candidate as TaskModelLike;
        }
    }

    throw new Error(`Task model exports are invalid. keys=${Object.keys(asRecord || {}).join(",")}`);
}

function resolveGetLatestExecutionTaskAction(
    moduleNs: unknown
): GetLatestExecutionTaskAction {
    const asRecord = moduleNs as Record<string, unknown>;
    const defaultExport = asRecord?.default as Record<string, unknown> | undefined;
    const candidates: unknown[] = [
        asRecord?.getLatestExecutionTaskAction,
        defaultExport?.getLatestExecutionTaskAction,
    ];

    for (const candidate of candidates) {
        if (typeof candidate === "function") {
            return candidate as GetLatestExecutionTaskAction;
        }
    }

    throw new Error(`Task repository exports are invalid. keys=${Object.keys(asRecord || {}).join(",")}`);
}

export const __testInternals = {
    resolveGetLatestExecutionTaskAction,
};

export class AgentRunner {
    private readonly retryManager: RetryManager;
    private readonly taskModel: TaskModelLike;
    private readonly toolRegistry: ToolRegistry;
    private readonly taskSuccessRegistry: TaskSuccessRegistry;
    private readonly internalBaseUrl: string;
    private readonly getLatestExecutionTaskAction: GetLatestExecutionTaskAction;
    private readonly persistentLoopEnabled: boolean;
    private readonly workerId: string;
    private readonly retrieveMemoryFn: RetrieveMemoryFn;
    private readonly getTaskPlanFn: GetTaskPlanFn;
    private readonly createOrRefreshTaskPlanFn: CreateOrRefreshTaskPlanFn;
    private readonly generateAndStoreReflectionFn: GenerateAndStoreReflectionFn;
    private readonly acquireTaskLeaseFn: AcquireTaskLeaseFn;
    private readonly heartbeatTaskLeaseFn: HeartbeatTaskLeaseFn;
    private readonly releaseTaskLeaseFn: ReleaseTaskLeaseFn;
    private readonly assertTransitionFn: AssertTransitionFn;
    private readonly updatePlanStepStateFn?: UpdatePlanStepStateFn;
    private readonly llmRequestFn?: LlmRequestFn;
    private readonly onExecutionUpdate?: ExecutionUpdateEmitter;
    private currentRunId: string | null = null;
    private currentExecutionSignal: AbortSignal | null = null;

    constructor(options?: {
        retryManager?: RetryManager;
        taskModel?: TaskModelLike;
        toolRegistry?: ToolRegistry;
        taskSuccessRegistry?: TaskSuccessRegistry;
        internalBaseUrl?: string;
        getLatestExecutionTaskAction?: GetLatestExecutionTaskAction;
        persistentLoopEnabled?: boolean;
        workerId?: string;
        retrieveMemoryFn?: RetrieveMemoryFn;
        getTaskPlanFn?: GetTaskPlanFn;
        createOrRefreshTaskPlanFn?: CreateOrRefreshTaskPlanFn;
        generateAndStoreReflectionFn?: GenerateAndStoreReflectionFn;
        acquireTaskLeaseFn?: AcquireTaskLeaseFn;
        heartbeatTaskLeaseFn?: HeartbeatTaskLeaseFn;
        releaseTaskLeaseFn?: ReleaseTaskLeaseFn;
        assertTransitionFn?: AssertTransitionFn;
        updatePlanStepStateFn?: UpdatePlanStepStateFn;
        llmRequestFn?: LlmRequestFn;
        onExecutionUpdate?: ExecutionUpdateEmitter;
    }) {
        this.retryManager = options?.retryManager ?? new RetryManager([1000, 2000, 5000]);
        this.taskModel = options?.taskModel ?? resolveTaskModel(taskModule);
        this.toolRegistry = options?.toolRegistry ?? this.createDefaultToolRegistry();
        this.taskSuccessRegistry = options?.taskSuccessRegistry ?? createDefaultTaskSuccessRegistry();
        this.internalBaseUrl = options?.internalBaseUrl ?? process.env.SOCKET_SERVER_URL ?? process.env.NEXT_PUBLIC_SOCKET_URL ?? "http://localhost:3001";
        this.getLatestExecutionTaskAction = options?.getLatestExecutionTaskAction ?? resolveGetLatestExecutionTaskAction(taskRepo);
        this.persistentLoopEnabled = options?.persistentLoopEnabled ?? (process.env.TASK_AGENT_PERSISTENT_LOOP_ENABLED === "true");
        this.workerId = options?.workerId ?? process.env.TASK_WORKER_ID ?? `${process.pid}-agent-runner`;
        this.retrieveMemoryFn = options?.retrieveMemoryFn ?? retrieveMemory;
        this.getTaskPlanFn = options?.getTaskPlanFn ?? getTaskPlan;
        this.createOrRefreshTaskPlanFn = options?.createOrRefreshTaskPlanFn ?? createOrRefreshTaskPlan;
        this.generateAndStoreReflectionFn = options?.generateAndStoreReflectionFn ?? generateAndStoreReflection;
        this.acquireTaskLeaseFn = options?.acquireTaskLeaseFn ?? acquireTaskLease;
        this.heartbeatTaskLeaseFn = options?.heartbeatTaskLeaseFn ?? heartbeatTaskLease;
        this.releaseTaskLeaseFn = options?.releaseTaskLeaseFn ?? releaseTaskLease;
        this.assertTransitionFn = options?.assertTransitionFn ?? assertTransition;
        this.updatePlanStepStateFn = options?.updatePlanStepStateFn;
        this.llmRequestFn = options?.llmRequestFn;
        this.onExecutionUpdate = options?.onExecutionUpdate;
    }

    private createDefaultToolRegistry() {
        const registry = new ToolRegistry();
        registry.register(new SendEmailTool());
        registry.register(new ScheduleMeetingTool());
        registry.register(new CreateIssueTool());
        return registry;
    }

    private trimCheckpoints(checkpoints: TaskCheckpoint[]) {
        const cap = 200;
        return checkpoints.length <= cap ? checkpoints : checkpoints.slice(checkpoints.length - cap);
    }

    private trimExecutionResults(results: TaskExecutionHistory["results"]) {
        const cap = 100;
        return results.length <= cap ? results : results.slice(results.length - cap);
    }

    private getExecutionHistory(task: TaskDocumentLike): TaskExecutionHistory {
        return {
            attempts: typeof task.executionHistory?.attempts === "number" ? task.executionHistory.attempts : 0,
            failures: typeof task.executionHistory?.failures === "number" ? task.executionHistory.failures : 0,
            results: Array.isArray(task.executionHistory?.results) ? task.executionHistory.results : [],
        };
    }

    private getConfidenceThreshold() {
        const configured = Number(process.env.TASK_AGENT_CONFIDENCE_THRESHOLD ?? 0.7);
        if (Number.isNaN(configured)) return 0.7;
        return Math.max(0, Math.min(1, configured));
    }

    private buildPreviousStepOutputs(plan: TaskPlanLike): PreviousStepOutputs {
        return collectPreviousStepOutputs(plan.steps);
    }

    private async requestLlmResponse(model: string, input: string): Promise<{ output_text?: string; output?: unknown }> {
        if (this.llmRequestFn) {
            return this.llmRequestFn({ model, input });
        }

        const provider = createDefaultLLMProvider();
        const startedAt = Date.now();

        const response = await provider.generate({
            model,
            input,
        }, {
            signal: this.currentExecutionSignal ?? undefined,
        });

        console.log("agent-runner llm:provider", {
            runId: this.currentRunId,
            model,
            provider: response.provider,
            latencyMs: Date.now() - startedAt,
            retryCount: 0,
            success: true,
        });

        return {
            output_text: response.output_text,
            output: response.output ?? response.raw,
        };
    }

    private async pauseForClarification(task: TaskDocumentLike, clarificationQuestion: string, stepId?: string) {
        await this.updateTask(task, {
            status: "waiting_for_input",
            lifecycleState: "paused",
            pausedReason: clarificationQuestion,
            blockedReason: stepId ? `Awaiting clarification for ${stepId}` : "Awaiting clarification",
            result: {
                success: false,
                confidence: 0,
                evidence: {
                    needsClarification: true,
                    clarificationQuestion,
                    stepId: stepId ?? null,
                },
                error: clarificationQuestion,
            },
        });
    }

    async resumeTask(taskId: string, userReply: string): Promise<RunTaskOutcome> {
        const task = await this.taskModel.findById(taskId);
        if (!task) {
            throw new Error(`Task not found: ${taskId}`);
        }

        await this.updateTask(task, {
            status: "executing",
            lifecycleState: "ready",
            pausedReason: userReply,
            blockedReason: null,
        });

        return this.runTask(taskId);
    }

    private async decideNextAction(
        task: TaskDocumentLike,
        executionHistory: TaskExecutionHistory,
        availableTools: AvailableToolForDecision[],
        iterationContext: IterationContextEntry[]
    ): Promise<NextActionDecision> {
        const model = process.env.TASK_AGENT_MODEL || "gpt-4o-mini";
        const confidenceThreshold = this.getConfidenceThreshold();

        const systemPrompt = "Return one JSON object only with keys: tool, confidence, parameters, reasoning, noAction, needsClarification, clarificationQuestion. No extra text.";

        const userPayload = {
            task: {
                id: task._id.toString(),
                title: task.title,
                description: task.description,
                status: task.status,
                progress: typeof task.progress === "number" ? task.progress : 0,
                result: task.result ?? null,
            },
            executionHistory,
            availableTools,
            iterationContext,
        };

        const llmRequest = {
            model,
            input: JSON.stringify({
                systemPrompt,
                userPayload,
            }),
            temperature: 0.0,
        };

        // Log sanitized request
        console.log("agent-runner llm:request", {
            runId: this.currentRunId,
            taskId: task._id.toString(),
            model,
            inputSummary: JSON.stringify(userPayload).slice(0, 2000),
        });

        let res;
        try {
            res = await this.requestLlmResponse(model, llmRequest.input);
        } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            console.error("agent-runner llm:error", { taskId: task._id.toString(), detail });
            throw new Error(`LLM_ERROR: ${detail}`);
        }

        // Log sanitized full response (avoid dumping headers / keys)
        try {
            console.log("agent-runner llm:response", {
                runId: this.currentRunId,
                taskId: task._id.toString(),
                stepId: null,
                responseText: (res.output_text ?? JSON.stringify(res.output ?? {}).slice(0, 2000)),
            });
        } catch { }

        const text = String(res.output_text ?? (Array.isArray(res.output) ? res.output.map((o: any) => (o.content ?? []).map((c: any) => c.text || c.url || JSON.stringify(c)).join('')).join('\n') : '')).trim();

        if (!text) {
            console.error("agent-runner llm:empty-response", { taskId: task._id.toString() });
            throw new Error("LLM_ERROR: empty response from model");
        }

        // parse JSON-only response per system instructions
        try {
            const parsedRaw = parseJsonText<unknown>(text).value ?? JSON.parse(text) as unknown;
            const parsed = llmDecisionSchema.safeParse(parsedRaw);
            if (!parsed.success) {
                console.error("agent-runner llm:parse-failure", { taskId: task._id.toString(), errors: parsed.error.flatten(), text: text.slice(0, 2000) });
                throw new Error("LLM_ERROR: response parsing failed");
            }

            const decision = parsed.data;
            if (decision.tool !== null) {
                const selectedTool = availableTools.find((t) => t.name === decision.tool);
                if (!selectedTool) {
                    throw new Error(`LLM_ERROR: requested tool not available: ${decision.tool}`);
                }
            }

            const needsClarification = Boolean(decision.needsClarification) || decision.confidence < confidenceThreshold;
            return {
                toolName: decision.tool,
                confidence: decision.confidence,
                toolInput: decision.parameters,
                reasoning: decision.reasoning ?? undefined,
                goalAchieved: Boolean(decision.noAction),
                noAction: Boolean(decision.noAction),
                needsClarification,
                clarificationQuestion: needsClarification
                    ? (decision.clarificationQuestion ?? "Please provide more context.")
                    : decision.clarificationQuestion ?? undefined,
            };
        } catch (err) {
            console.error("agent-runner llm:parse-failure", { taskId: task._id.toString(), err: err instanceof Error ? err.message : String(err), text: text.slice(0, 2000) });
            throw new Error("LLM_ERROR: response parsing failed");
        }
    }

    private extractEmailFromText(text: string): string | null {
        const emailRegex = /([a-zA-Z0-9._%-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
        const match = text.match(emailRegex);
        return match ? match[0] : null;
    }

    private generateEmailSubject(taskTitle: string): string {
        // Extract key words from task title, removing common phrases
        const cleaned = taskTitle
            .replace(/^(send an email to|report|notify|inform|alert|update|create|schedule)/gi, "")
            .replace(/to\s+\w+@[\w.]+/gi, "")
            .replace(/^\s+|\s+$/g, "")
            .trim();

        // If we have a cleaned title, use it; otherwise use the original
        if (cleaned.length > 5) {
            return cleaned.split(" ").slice(0, 8).join(" ");
        }

        // Fallback: extract first meaningful part
        const words = taskTitle.split(" ");
        return words.slice(0, 6).join(" ");
    }

    private generateEmailBody(taskTitle: string, taskDescription: string, taskId: string): string {
        const timestamp = new Date().toISOString();

        // Extract key action items from title and description
        const actionMatch = taskTitle.match(/to\s+(.+?)(?:\s+|$)/i);
        const action = actionMatch ? actionMatch[1] : taskTitle;

        return `
Task Notification

Task Title: ${taskTitle}

Details:
• Task ID: ${taskId}
• Created At: ${timestamp}
• Priority: High (Automated)

Description:
${taskDescription || "No additional details provided."}

Action Required:
Please review this task and take appropriate action.

---
This is an automated notification generated by the Task Execution System.
Reply to confirm receipt or contact support if you have questions.
`.trim();
    }

    private getDefaultToolInput(toolName: string, task: TaskDocumentLike): Record<string, unknown> {
        if (toolName === "send_email") {
            const recipientEmail = this.extractEmailFromText(task.title) || this.extractEmailFromText(task.description || "");
            const subject = this.generateEmailSubject(task.title);
            const body = this.generateEmailBody(task.title, task.description || "", task._id.toString());

            return {
                to: recipientEmail || process.env.RESEND_FROM_EMAIL || "noreply@task-execution.local",
                subject: subject.length > 0 ? subject : "Task Notification",
                body,
            };
        }
        if (toolName === "schedule_meeting") {
            return {
                summary: task.title,
                whenText: "tomorrow 10am",
            };
        }
        if (toolName === "create_github_issue") {
            return {
                title: task.title,
                body: `Task ID: ${task._id.toString()}\n\n${task.description || "No description provided"}`,
            };
        }
        return {};
    }

    private progressForStep(step: "execute" | "observe" | "verify" | "adjust" | "done" | "failed", status: "started" | "completed" | "failed") {
        if (step === "done" || step === "failed") return 100;
        if (step === "execute") return status === "completed" ? 35 : 15;
        if (step === "observe") return status === "completed" ? 55 : 45;
        if (step === "verify") return status === "completed" ? 75 : 70;
        if (step === "adjust") return status === "completed" ? 85 : 80;
        return 0;
    }

    private async appendCheckpoint(
        task: TaskDocumentLike,
        input: {
            step: "execute" | "observe" | "verify" | "adjust" | "done" | "failed";
            status: "started" | "completed" | "failed";
            progress?: number;
            historyDelta?: ExecutionHistoryDelta;
        }
    ) {
        const nextCheckpoints = this.trimCheckpoints([
            ...(task.checkpoints ?? []),
            {
                step: input.step,
                status: input.status,
                timestamp: new Date().toISOString(),
            },
        ]);

        const history = this.getExecutionHistory(task);
        const nextHistory: TaskExecutionHistory = {
            attempts: history.attempts,
            failures: history.failures,
            results: [...history.results],
        };

        if (input.historyDelta?.attempts) {
            nextHistory.attempts += input.historyDelta.attempts;
        }
        if (input.historyDelta?.failures) {
            nextHistory.failures += input.historyDelta.failures;
        }
        if (input.historyDelta?.appendResult) {
            nextHistory.results = this.trimExecutionResults([
                ...nextHistory.results,
                {
                    attempt: input.historyDelta.appendResult.attempt,
                    success: input.historyDelta.appendResult.success,
                    summary: input.historyDelta.appendResult.summary,
                    ...(input.historyDelta.appendResult.error ? { error: input.historyDelta.appendResult.error } : {}),
                    ...(input.historyDelta.appendResult.validationLog
                        ? { validationLog: input.historyDelta.appendResult.validationLog }
                        : {}),
                    timestamp: new Date().toISOString(),
                },
            ]);
        }

        await this.updateTask(task, {
            progress: typeof input.progress === "number" ? input.progress : this.progressForStep(input.step, input.status),
            checkpoints: nextCheckpoints,
            executionHistory: nextHistory,
        });
    }

    private async emitExecutionUpdate(task: TaskDocumentLike, input: {
        state: TaskExecutionUpdatedPayload["state"];
        summary: string | null;
        error?: string | null;
        phase?: TaskExecutionUpdatedPayload["phase"];
        step?: string | null;
        progress?: number;
        details?: TaskExecutionUpdatedPayload["details"];
        runId?: string | null;
        attempt?: number | null;
    }) {
        if (!this.onExecutionUpdate) return;
        await this.onExecutionUpdate({
            taskId: task._id.toString(),
            conversationId: task.conversationId.toString(),
            state: input.state,
            actionType: this.mapToolNameToActionType(input.details?.toolName ?? null),
            summary: input.summary,
            error: input.error ?? null,
            updatedAt: new Date().toISOString(),
            phase: input.phase,
            step: input.step ?? null,
            progress: input.progress,
            details: input.details ?? null,
            ...(input.runId ? { runId: input.runId } : {}),
            ...(typeof input.attempt === "number" ? { attempt: input.attempt } : {}),
        });
    }

    async runTask(taskId: string): Promise<RunTaskOutcome> {
        const runId = `run-${taskId}-${Date.now()}`;
        this.currentRunId = runId;
        try {
            if (this.persistentLoopEnabled) {
                return await this.runTaskPersistent(taskId, runId);
            }

            const task = await this.taskModel.findById(taskId);
            if (!task) {
                throw new Error(`Task not found: ${taskId}`);
            }

            const action = await this.getLatestExecutionTaskAction(taskId);
            if (!action) {
                throw new Error(`No execution action found for task: ${taskId}`);
            }

            const context: LoopContext = {
                task,
                action: {
                    taskId: action.taskId.toString(),
                    conversationId: action.conversationId.toString(),
                    toolName: action.toolName ?? action.actionType,
                    parameters: action.parameters ?? {},
                    messageId: action.messageId ? action.messageId.toString() : null,
                    executionState: action.executionState ?? null,
                },
                retryCount: typeof task.retryCount === "number" ? task.retryCount : 0,
                maxRetries: typeof task.maxRetries === "number" ? task.maxRetries : 2,
                attemptPayload: {
                    taskId: action.taskId.toString(),
                    conversationId: action.conversationId.toString(),
                    toolName: action.toolName ?? action.actionType,
                    parameters: action.parameters ?? {},
                    messageId: action.messageId ? action.messageId.toString() : null,
                    executionState: action.executionState ?? null,
                },
                observed: null,
                verification: null,
            };
            const availableTools = this.toolRegistry.listForLLM();
            const maxIterations = Math.max(1, Number(process.env.TASK_AGENT_MAX_ITERATIONS || 5));
            let iteration = 0;
            let goalAchieved = false;
            const iterationContext: IterationContextEntry[] = [];

            console.log("agent-runner lifecycle:start", {
                taskId,
                toolName: context.action.toolName,
                retryCount: context.retryCount,
                maxRetries: context.maxRetries,
                maxIterations,
            });

            await this.updateTask(task, {
                status: "executing",
                retryCount: context.retryCount,
                maxRetries: context.maxRetries,
            });
            await this.emitExecutionUpdate(task, {
                state: "running",
                summary: "Agent runner started.",
                phase: "reason",
                step: "run_task",
                progress: 10,
                details: {
                    toolName: context.action.toolName,
                },
            });

            while (!goalAchieved && iteration < maxIterations && task.status !== "completed") {
                iteration += 1;
                console.log("agent-runner lifecycle:loop", {
                    taskId,
                    iteration,
                    maxIterations,
                });

                try {
                    let decision: NextActionDecision;
                    try {
                        decision = await this.decideNextAction(task, this.getExecutionHistory(task), availableTools, iterationContext);
                    } catch (err) {
                        const message = err instanceof Error ? err.message : String(err);
                        if (typeof message === "string" && message.startsWith("LLM_ERROR:")) {
                            // LLM failed — do not execute any tool. Respect retry semantics.
                            context.retryCount += 1;
                            console.error("agent-runner llm:fatal", { taskId, reason: message, retryCount: context.retryCount });

                            if (context.retryCount <= context.maxRetries) {
                                // schedule a retry and return control so orchestrator can requeue
                                await this.updateTask(task, {
                                    lifecycleState: "retry_scheduled",
                                    status: "partial",
                                    retryCount: context.retryCount,
                                    maxRetries: context.maxRetries,
                                });

                                await this.appendCheckpoint(task, {
                                    step: "failed",
                                    status: "completed",
                                    progress: 100,
                                });

                                return {
                                    completed: false,
                                    retryCount: context.retryCount,
                                    maxRetries: context.maxRetries,
                                    result: context.observed,
                                    verification: context.verification,
                                };
                            }

                            // exceeded retries -> move to dead-letter (failed)
                            await this.updateTask(task, {
                                status: "failed",
                                retryCount: context.retryCount,
                                maxRetries: context.maxRetries,
                                progress: 100,
                                result: {
                                    success: false,
                                    confidence: 0,
                                    evidence: { reason: message },
                                    error: message,
                                },
                            });

                            await this.appendCheckpoint(task, {
                                step: "failed",
                                status: "completed",
                                progress: 100,
                            });

                            return {
                                completed: false,
                                retryCount: context.retryCount,
                                maxRetries: context.maxRetries,
                                result: context.observed,
                                verification: context.verification,
                            };
                        }

                        throw err;
                    }
                    await this.emitExecutionUpdate(task, {
                        state: "running",
                        summary: decision.reasoning ?? "Selected next action.",
                        phase: "reason",
                        step: "decide_next_action",
                        progress: 20,
                        details: {
                            reasoning: decision.reasoning ?? null,
                            toolName: decision.toolName ?? undefined,
                            toolInput: decision.toolInput,
                        },
                    });
                    if (decision.needsClarification) {
                        await this.updateTask(task, {
                            status: "waiting_for_input",
                            lifecycleState: "paused",
                            pausedReason: decision.clarificationQuestion ?? decision.reasoning ?? "Clarification required.",
                            blockedReason: decision.clarificationQuestion ?? "Awaiting clarification.",
                            progress: 100,
                            result: {
                                success: false,
                                confidence: 0,
                                evidence: {
                                    needsClarification: true,
                                    clarificationQuestion: decision.clarificationQuestion ?? null,
                                },
                                error: decision.reasoning ?? "Execution paused: clarification required.",
                            },
                        });

                        await this.appendCheckpoint(task, {
                            step: "failed",
                            status: "completed",
                            progress: 100,
                        });
                        await this.emitExecutionUpdate(task, {
                            state: "blocked",
                            summary: "Execution paused; clarification required.",
                            error: null,
                            phase: "reason",
                            step: "needs_clarification",
                            progress: typeof task.progress === "number" ? task.progress : 0,
                            details: {
                                reasoning: decision.reasoning ?? null,
                                toolName: decision.toolName,
                                toolInput: Object.assign({}, decision.toolInput ?? {}, { _clarificationQuestion: decision.clarificationQuestion ?? null }),
                            },
                        });

                        return {
                            completed: false,
                            retryCount: context.retryCount,
                            maxRetries: context.maxRetries,
                            result: context.observed,
                            verification: context.verification,
                        };
                    }

                    if (decision.noAction || decision.goalAchieved) {
                        goalAchieved = true;
                        await this.updateTask(task, {
                            status: "completed",
                            progress: 100,
                            result: {
                                success: true,
                                confidence: context.verification?.confidence ?? 1,
                                evidence: {
                                    decision,
                                    execution: context.observed?.evidence ?? null,
                                },
                            },
                        });

                        await this.appendCheckpoint(task, {
                            step: "done",
                            status: "completed",
                            progress: 100,
                        });
                        await this.emitExecutionUpdate(task, {
                            state: "succeeded",
                            summary: decision.reasoning ?? "Goal achieved without additional tool execution.",
                            phase: "finalize",
                            step: "goal_achieved",
                            progress: 100,
                            details: {
                                reasoning: decision.reasoning ?? null,
                                toolName: decision.toolName,
                                toolInput: decision.toolInput,
                                verification: context.verification
                                    ? {
                                        success: context.verification.success,
                                        confidence: context.verification.confidence,
                                    }
                                    : null,
                            },
                        });

                        return {
                            completed: true,
                            retryCount: context.retryCount,
                            maxRetries: context.maxRetries,
                            result: context.observed,
                            verification: context.verification,
                        };
                    }

                    const selectedToolName = decision.toolName ?? "none";

                    context.attemptPayload = {
                        ...context.attemptPayload,
                        toolName: selectedToolName,
                        parameters: decision.toolInput,
                    };
                    context.action = context.attemptPayload;

                    if (decision.reasoning) {
                        console.log("agent-runner step:decide", {
                            taskId,
                            toolName: selectedToolName,
                            reasoning: decision.reasoning,
                        });
                    }

                    iterationContext.push({
                        iteration,
                        decision: {
                            toolName: decision.toolName,
                            reasoning: decision.reasoning,
                            noAction: decision.noAction,
                            needsClarification: decision.needsClarification,
                        },
                    });

                    await this.appendCheckpoint(task, {
                        step: "execute",
                        status: "started",
                        historyDelta: { attempts: 1 },
                    });
                    await this.emitExecutionUpdate(task, {
                        state: "running",
                        summary: `Executing tool '${context.attemptPayload.toolName}'.`,
                        phase: "tool_execute",
                        step: "execute_tool",
                        progress: 35,
                        details: {
                            reasoning: decision.reasoning ?? null,
                            toolName: context.attemptPayload.toolName,
                            toolInput: context.attemptPayload.parameters,
                        },
                    });

                    const executed = await this.execute({
                        ...context.attemptPayload,
                        stepId: context.action.toolName,
                        attempt: context.retryCount + 1,
                        idempotencyKey: this.buildIdempotencyKey(taskId, context.action.toolName, context.retryCount + 1),
                    });

                    await this.appendCheckpoint(task, {
                        step: "execute",
                        status: "completed",
                    });

                    await this.appendCheckpoint(task, {
                        step: "observe",
                        status: "started",
                    });
                    await this.emitExecutionUpdate(task, {
                        state: "running",
                        summary: "Observing tool execution output.",
                        phase: "observe",
                        step: "observe_result",
                        progress: 55,
                        details: {
                            toolName: context.attemptPayload.toolName,
                            toolOutput: this.summarizeEvidence(executed.evidence),
                        },
                    });

                    context.observed = await this.observe(context, executed);

                    const currentContext = iterationContext[iterationContext.length - 1];
                    if (currentContext) {
                        currentContext.result = {
                            summary: context.observed.summary,
                            adapterSuccess: context.observed.adapterSuccess,
                            error: context.observed.error,
                        };
                    }

                    await this.appendCheckpoint(task, {
                        step: "observe",
                        status: "completed",
                    });

                    await this.appendCheckpoint(task, {
                        step: "verify",
                        status: "started",
                    });
                    await this.emitExecutionUpdate(task, {
                        state: "running",
                        summary: "Verifying execution outcome.",
                        phase: "verify",
                        step: "verify_result",
                        progress: 75,
                        details: {
                            toolName: context.attemptPayload.toolName,
                            toolOutput: this.summarizeEvidence(context.observed?.evidence),
                        },
                    });

                    context.verification = await this.verify(context.observed, context);
                    await this.emitExecutionUpdate(task, {
                        state: context.verification.success ? "running" : "failed",
                        summary: context.verification.success ? "Verification passed." : "Verification failed.",
                        error: context.verification.success ? null : (context.observed?.error ?? "Verification failed"),
                        phase: "verify",
                        step: "verification_completed",
                        progress: context.verification.success ? 85 : 80,
                        details: {
                            toolName: context.attemptPayload.toolName,
                            toolOutput: this.summarizeEvidence(context.observed?.evidence),
                            verification: {
                                success: context.verification.success,
                                confidence: context.verification.confidence,
                            },
                        },
                    });

                    if (context.verification.success) {
                        await this.appendCheckpoint(task, {
                            step: "verify",
                            status: "completed",
                            historyDelta: {
                                appendResult: {
                                    attempt: context.retryCount + 1,
                                    success: true,
                                    summary: context.observed.summary,
                                    validationLog: context.verification.validationLog,
                                },
                            },
                        });
                    } else {
                        await this.appendCheckpoint(task, {
                            step: "verify",
                            status: "failed",
                            historyDelta: {
                                failures: 1,
                                appendResult: {
                                    attempt: context.retryCount + 1,
                                    success: false,
                                    summary: context.observed.summary,
                                    error: context.observed.error ?? "Verification failed",
                                    validationLog: context.verification.validationLog,
                                },
                            },
                        });
                    }

                    if (context.verification.success) {
                        await this.updateTask(task, {
                            status: "completed",
                            retryCount: context.retryCount,
                            maxRetries: context.maxRetries,
                            progress: 100,
                            result: {
                                success: true,
                                confidence: context.verification.confidence,
                                evidence: {
                                    execution: context.observed.evidence,
                                    validationLog: context.verification.validationLog,
                                },
                            },
                        });

                        await this.appendCheckpoint(task, {
                            step: "done",
                            status: "completed",
                            progress: 100,
                        });
                        await this.emitExecutionUpdate(task, {
                            state: "succeeded",
                            summary: context.observed.summary,
                            phase: "finalize",
                            step: "task_completed",
                            progress: 100,
                            details: {
                                toolName: context.attemptPayload.toolName,
                                toolInput: context.attemptPayload.parameters,
                                toolOutput: this.summarizeEvidence(context.observed.evidence),
                                verification: {
                                    success: context.verification.success,
                                    confidence: context.verification.confidence,
                                },
                            },
                        });

                        console.log("agent-runner lifecycle:completed", {
                            taskId,
                            confidence: context.verification.confidence,
                        });
                        return {
                            completed: true,
                            retryCount: context.retryCount,
                            maxRetries: context.maxRetries,
                            result: context.observed,
                            verification: context.verification,
                        };
                    }

                    context.retryCount += 1;

                    console.warn("agent-runner lifecycle:continue", {
                        taskId,
                        iteration,
                        reason: context.observed.error ?? "verification failed",
                    });

                    await this.updateTask(task, {
                        status: "executing",
                        retryCount: context.retryCount,
                        maxRetries: context.maxRetries,
                    });
                    await this.emitExecutionUpdate(task, {
                        state: "running",
                        summary: "Verification failed; preparing next iteration.",
                        error: context.observed.error ?? "verification failed",
                        phase: "reason",
                        step: "retry_iteration",
                        progress: 60,
                        details: {
                            toolName: context.attemptPayload.toolName,
                            toolOutput: context.observed.evidence,
                        },
                    });
                } catch (error) {
                    const reason = error instanceof Error ? error.message : "unknown execution error";

                    if (/abort|timed out|lease lost/i.test(reason)) {
                        await this.updateTask(task, {
                            status: "failed",
                            retryCount: context.retryCount,
                            maxRetries: context.maxRetries,
                            progress: 100,
                            result: {
                                success: false,
                                confidence: 0,
                                evidence: { reason },
                                error: reason,
                            },
                        });

                        await this.appendCheckpoint(task, {
                            step: "failed",
                            status: "completed",
                            progress: 100,
                        });

                        await this.emitExecutionUpdate(task, {
                            state: "failed",
                            summary: reason,
                            error: reason,
                            phase: "tool_execute",
                            step: "iteration_aborted",
                            progress: 100,
                            details: {
                                toolName: context.attemptPayload.toolName,
                                toolInput: context.attemptPayload.parameters,
                            },
                        });

                        return {
                            completed: false,
                            retryCount: context.retryCount,
                            maxRetries: context.maxRetries,
                            result: context.observed,
                            verification: context.verification,
                        };
                    }

                    // Generic non-LLM error: record observation and increment retry count
                    await this.appendCheckpoint(task, {
                        step: "execute",
                        status: "failed",
                        historyDelta: {
                            failures: 1,
                            appendResult: {
                                attempt: context.retryCount + 1,
                                success: false,
                                summary: "Execution failed before verification",
                                error: reason,
                            },
                        },
                    });

                    context.observed = {
                        summary: "Execution failed before verification",
                        adapterSuccess: false,
                        evidence: {
                            reason,
                            iteration,
                        },
                        error: reason,
                    };

                    context.retryCount += 1;

                    console.warn("agent-runner lifecycle:iteration-error", {
                        taskId,
                        reason,
                        retryCount: context.retryCount,
                        maxRetries: context.maxRetries,
                    });

                    await this.updateTask(task, {
                        status: "executing",
                        retryCount: context.retryCount,
                        maxRetries: context.maxRetries,
                    });
                    await this.emitExecutionUpdate(task, {
                        state: "failed",
                        summary: "Execution iteration failed.",
                        error: reason,
                        phase: "tool_execute",
                        step: "iteration_exception",
                        progress: 50,
                        details: {
                            toolName: context.attemptPayload.toolName,
                            toolInput: context.attemptPayload.parameters,
                        },
                    });
                }
            }

            await this.updateTask(task, {
                status: "failed",
                retryCount: context.retryCount,
                maxRetries: context.maxRetries,
                progress: 100,
                result: {
                    success: false,
                    confidence: context.verification?.confidence ?? 0,
                    evidence: context.observed?.evidence ?? null,
                    error: "Max iterations reached before goal achievement.",
                },
            });

            await this.appendCheckpoint(task, {
                step: "failed",
                status: "completed",
                progress: 100,
            });
            await this.emitExecutionUpdate(task, {
                state: "failed",
                summary: "Max iterations reached before goal achievement.",
                error: "Max iterations reached before goal achievement.",
                phase: "finalize",
                step: "max_iterations_reached",
                progress: 100,
                details: {
                    toolName: context.attemptPayload.toolName,
                    toolInput: context.attemptPayload.parameters,
                    toolOutput: this.summarizeEvidence(context.observed?.evidence),
                    verification: context.verification
                        ? {
                            success: context.verification.success,
                            confidence: context.verification.confidence,
                        }
                        : null,
                },
            });

            console.log("agent-runner lifecycle:exhausted", {
                taskId,
                retryCount: context.retryCount,
                maxRetries: context.maxRetries,
                maxIterations,
            });

            return {
                completed: false,
                retryCount: context.retryCount,
                maxRetries: context.maxRetries,
                result: context.observed,
                verification: context.verification,
            };
        } finally {
            this.currentRunId = null;
        }
    }

    private isTransientFailure(error?: string) {
        if (!error) return false;
        const lowered = error.toLowerCase();
        return lowered.includes("timeout")
            || lowered.includes("temporar")
            || lowered.includes("429")
            || lowered.includes("502")
            || lowered.includes("503")
            || lowered.includes("504")
            || lowered.includes("econn")
            || lowered.includes("network");
    }

    private async ensurePlan(task: TaskDocumentLike): Promise<TaskPlanLike> {
        let plan = await this.getTaskPlanFn(task._id.toString()) as unknown as TaskPlanLike | null;
        if (!plan) {
            await this.transitionLifecycle(task, "planning");
            await this.createOrRefreshTaskPlanFn(
                {
                    taskId: task._id.toString(),
                    conversationId: task.conversationId.toString(),
                    title: task.title,
                    description: task.description,
                    sourceMessageIds: (task.sourceMessageIds ?? []).map((id) => id.toString()),
                    availableTools: this.toolRegistry.listForLLM().map((tool) => ({
                        name: tool.name,
                        description: tool.description,
                    })),
                },
                { llmRequestFn: this.llmRequestFn }
            );
            await this.transitionLifecycle(task, "ready");
            plan = await this.getTaskPlanFn(task._id.toString()) as unknown as TaskPlanLike | null;
        }

        if (!plan) {
            throw new Error(`Failed to load task plan for task: ${task._id.toString()}`);
        }

        return plan;
    }

    private async transitionLifecycle(
        task: TaskDocumentLike,
        nextState: "planning" | "ready" | "executing" | "waiting_for_approval" | "blocked" | "retry_scheduled" | "paused" | "completed" | "failed"
    ) {
        const current = task.lifecycleState ?? "ready";
        if (current === nextState) return;
        this.assertTransitionFn(current, nextState);

        task.lifecycleState = nextState;
        if (nextState === "completed") {
            task.status = "completed";
        } else if (nextState === "failed") {
            task.status = "failed";
        } else if (nextState === "executing") {
            task.status = "executing";
        } else if (nextState === "waiting_for_approval" || nextState === "blocked") {
            task.status = "partial";
        } else if (nextState === "ready") {
            task.status = "pending";
        }

        await this.updateTask(task, {
            status: task.status,
            lifecycleState: task.lifecycleState,
        });
    }

    private async pickNextRunnableStep(plan: TaskPlanLike): Promise<PlanStepLike | null> {
        const byId = new Map(plan.steps.map((step) => [step.stepId, step]));

        const runnable = plan.steps
            .filter((step) => step.state === "ready" || step.state === "retry_scheduled")
            .filter((step) => {
                if (step.overrideDependencies) {
                    return true;
                }

                if (!step.dependencies || step.dependencies.length === 0) {
                    return true;
                }

                if (step.fallbackPolicy === "immediate_execution") {
                    return step.dependencies.every((dependencyId) => {
                        const state = byId.get(dependencyId)?.state;
                        return state === "completed" || state === "failed" || state === "skipped";
                    });
                }

                return step.dependencies.every((dependencyId) => byId.get(dependencyId)?.state === "completed");
            })
            .sort((left, right) => left.order - right.order);

        return runnable[0] ?? null;
    }

    private async updatePlanStepState(taskId: string, stepId: string, patch: Partial<PlanStepLike>) {
        if (this.updatePlanStepStateFn) {
            await this.updatePlanStepStateFn(taskId, stepId, patch);
            return;
        }

        const setPatch: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(patch)) {
            setPatch[`steps.$.${key}`] = value as unknown;
        }

        await TaskPlanModel.updateOne(
            {
                taskId,
                "steps.stepId": stepId,
            },
            {
                $set: {
                    ...setPatch,
                    activeStepId: stepId,
                },
            }
        ).exec();
    }

    private rankStepTools(step: PlanStepLike, longTermMemory: Array<Record<string, unknown>>) {
        const historyByTool = new Map<string, number[]>();

        for (const item of longTermMemory) {
            const toolName = typeof item.toolName === "string" ? item.toolName : null;
            if (!toolName) continue;
            const impact = typeof item.successImpact === "number" ? item.successImpact : 0;
            const normalized = Math.max(0, Math.min(1, (impact + 1) / 2));
            const list = historyByTool.get(toolName) ?? [];
            list.push(normalized);
            historyByTool.set(toolName, list);
        }

        const candidates = step.toolCandidates.length > 0
            ? step.toolCandidates
            : this.toolRegistry.listForLLM().map((tool) => ({
                toolName: tool.name,
                confidence: 0.5,
                riskLevel: "medium" as const,
            }));

        const inputs: ToolRankingInput[] = candidates
            .filter((candidate) => candidate.toolName !== "none")
            .map((candidate) => {
                const history = historyByTool.get(candidate.toolName) ?? [];
                const historicalSuccessRate = history.length > 0
                    ? history.reduce((sum, value) => sum + value, 0) / history.length
                    : 0.5;

                return {
                    toolName: candidate.toolName as Exclude<TaskExecutionActionType, "none">,
                    capabilityScore: candidate.confidence,
                    historicalSuccessRate,
                    riskPenalty: candidate.riskLevel === "high" ? 0.7 : candidate.riskLevel === "medium" ? 0.35 : 0.1,
                    recentFailurePenalty: 0,
                };
            });

        return rankTools(inputs);
    }

    private async decideStepAction(input: {
        task: TaskDocumentLike;
        step: PlanStepLike;
        rankedTools: ReturnType<typeof rankTools>;
        shortTermMemory: Array<Record<string, unknown>>;
        longTermMemory: Array<Record<string, unknown>>;
        previousStepOutputs: PreviousStepOutputs;
        clarificationReply?: string | null;
        previousError?: string | null;
        previousParameters?: Record<string, unknown> | null;
        iteration: number;
    }): Promise<NextActionDecision> {
        const ranked = input.rankedTools;

        const model = process.env.TASK_AGENT_MODEL || "gpt-4o-mini";
        const confidenceThreshold = this.getConfidenceThreshold();

        const userPayload = {
            task: {
                id: input.task._id.toString(),
                title: input.task.title,
                description: input.task.description,
            },
            currentStep: input.step,
            rankedTools: ranked,
            memory: {
                shortTerm: input.shortTermMemory.slice(0, 5),
                longTerm: input.longTermMemory.slice(0, 5),
            },
            previousStepOutputs: input.previousStepOutputs,
            clarificationReply: input.clarificationReply ?? null,
            previousError: input.previousError ?? null,
            previousParameters: input.previousParameters ?? null,
            iteration: input.iteration,
        };

        const systemPrompt = "Return one JSON object only with keys: tool, confidence, parameters, reasoning, needsClarification, clarificationQuestion. No extra text.";

        console.log("agent-runner llm:step-request", { runId: this.currentRunId, taskId: input.task._id.toString(), stepId: input.step.stepId, model, payloadSummary: JSON.stringify(userPayload).slice(0, 2000) });

        let res;
        try {
            res = await this.requestLlmResponse(model, JSON.stringify({ systemPrompt, userPayload }));
        } catch (err) {
            console.error("agent-runner llm:step-error", { runId: this.currentRunId, taskId: input.task._id.toString(), stepId: input.step.stepId, err: err instanceof Error ? err.message : String(err) });
            throw new Error(`LLM_ERROR: ${err instanceof Error ? err.message : String(err)}`);
        }

        const text = String(res.output_text ?? (Array.isArray(res.output) ? res.output.map((o: any) => (o.content ?? []).map((c: any) => c.text || JSON.stringify(c)).join('')).join('\n') : '')).trim();
        if (!text) {
            console.error("agent-runner llm:step-empty", { runId: this.currentRunId, taskId: input.task._id.toString(), stepId: input.step.stepId });
            throw new Error("LLM_ERROR: empty response from model");
        }

        try {
            const parsedRaw = parseJsonText<unknown>(text).value ?? JSON.parse(text) as unknown;
            const parsed = llmDecisionSchema.safeParse(parsedRaw);
            if (!parsed.success) {
                console.error("agent-runner llm:step-parse-failure", { runId: this.currentRunId, taskId: input.task._id.toString(), stepId: input.step.stepId, errors: parsed.error.flatten(), text: text.slice(0, 2000) });
                throw new Error("LLM_ERROR: response parsing failed");
            }

            const decision = parsed.data;
            if (decision.tool !== null) {
                const matches = ranked.some((r) => r.toolName === decision.tool);
                if (!matches) {
                    throw new Error(`LLM_ERROR: selected tool not in ranked list: ${decision.tool}`);
                }
            }

            const needsClarification = Boolean(decision.needsClarification) || decision.confidence < confidenceThreshold;

            return {
                toolName: decision.tool,
                confidence: decision.confidence,
                toolInput: decision.parameters,
                reasoning: decision.reasoning,
                goalAchieved: Boolean(decision.noAction),
                noAction: Boolean(decision.noAction),
                needsClarification,
                clarificationQuestion: needsClarification
                    ? (decision.clarificationQuestion ?? "Please provide more context.")
                    : decision.clarificationQuestion ?? undefined,
            };
        } catch (err) {
            console.error("agent-runner llm:step-parse-failure", { runId: this.currentRunId, taskId: input.task._id.toString(), stepId: input.step.stepId, err: err instanceof Error ? err.message : String(err), text: text.slice(0, 2000) });
            throw new Error("LLM_ERROR: response parsing failed");
        }
    }

    private async runTaskPersistent(taskId: string, runId: string): Promise<RunTaskOutcome> {
        const task = await this.taskModel.findById(taskId);
        if (!task) {
            throw new Error(`Task not found: ${taskId}`);
        }

        const lease = await this.acquireTaskLeaseFn(taskId, this.workerId);
        if (!lease) {
            return {
                completed: false,
                retryCount: typeof task.retryCount === "number" ? task.retryCount : 0,
                maxRetries: typeof task.maxRetries === "number" ? task.maxRetries : 2,
                result: null,
                verification: null,
            };
        }

        const maxIterations = Math.max(1, Number(process.env.TASK_AGENT_MAX_ITERATIONS || 8));
        const iterationTimeoutMs = Math.max(1000, Number(process.env.TASK_AGENT_ITERATION_TIMEOUT_MS || 120000));
        const leaseMs = Math.max(1000, Number(process.env.TASK_LEASE_MS || 30000));
        const watchdogIntervalMs = Math.max(1000, Math.floor(leaseMs / 3));
        let iteration = typeof task.iterationCount === "number" ? task.iterationCount : 0;
        let lastResult: ActionExecutionResult | null = null;
        let lastVerification: VerificationOutcome | null = null;
        const runAbortController = new AbortController();
        this.currentRunId = runId;
        const watchdog = this.startLeaseWatchdog(taskId, runAbortController, runId, watchdogIntervalMs);

        try {
            await this.ensurePlan(task);
            await this.transitionLifecycle(task, "ready");

            while (iteration < maxIterations) {
                iteration += 1;
                const iterationAbortController = new AbortController();
                const iterationTimeoutHandle = setTimeout(() => iterationAbortController.abort(), iterationTimeoutMs);
                this.currentExecutionSignal = combineAbortSignals(runAbortController.signal, iterationAbortController.signal) ?? runAbortController.signal;

                try {
                    await this.heartbeatTaskLeaseFn(taskId, this.workerId);

                    const latestTask = await this.taskModel.findById(taskId);
                    if (!latestTask) {
                        throw new Error(`Task disappeared during execution: ${taskId}`);
                    }

                    const plan = await this.ensurePlan(latestTask);
                    const step = await this.pickNextRunnableStep(plan);

                    if (!step) {
                        const hasFailedStep = plan.steps.some((entry) => entry.state === "failed" || entry.state === "blocked");
                        const hasPending = plan.steps.some((entry) => ["ready", "running", "retry_scheduled", "waiting_for_dependency"].includes(entry.state));

                        if (hasFailedStep) {
                            await this.transitionLifecycle(latestTask, "failed");
                            break;
                        }

                        if (!hasPending) {
                            await this.transitionLifecycle(latestTask, "completed");
                            break;
                        }

                        await this.transitionLifecycle(latestTask, "blocked");
                        latestTask.blockedReason = "No runnable steps due to dependency constraints.";
                        await this.updateTask(latestTask, {
                            status: latestTask.status,
                            lifecycleState: latestTask.lifecycleState,
                        });
                        break;
                    }

                    await this.transitionLifecycle(latestTask, "executing");
                    await this.updateTask(latestTask, {
                        status: latestTask.status,
                        lifecycleState: latestTask.lifecycleState,
                        currentStepId: step.stepId,
                        iterationCount: iteration,
                    });

                    await this.updatePlanStepState(taskId, step.stepId, {
                        state: "running",
                        startedAt: new Date(),
                        attempts: (step.attempts ?? 0) + 1,
                        selectedToolName: step.selectedToolName ?? null,
                        lastError: null,
                    });

                    const previousStepOutputs = this.buildPreviousStepOutputs(plan);
                    const clarificationReply = typeof latestTask.pausedReason === "string" && latestTask.pausedReason.trim().length > 0
                        ? latestTask.pausedReason
                        : null;
                    if (clarificationReply) {
                        await this.updateTask(latestTask, { pausedReason: null });
                    }

                    const memory = await this.retrieveMemoryFn({
                        taskId,
                        conversationId: latestTask.conversationId.toString(),
                        toolName: step.selectedToolName ?? undefined,
                        limit: 10,
                    });

                    const rankedTools = this.rankStepTools(step, memory.longTerm as Array<Record<string, unknown>>);

                    let decision: NextActionDecision;
                    try {
                        decision = await this.decideStepAction({
                            task: latestTask,
                            step,
                            rankedTools,
                            shortTermMemory: memory.shortTerm as Array<Record<string, unknown>>,
                            longTermMemory: memory.longTerm as Array<Record<string, unknown>>,
                            previousStepOutputs,
                            clarificationReply,
                            previousError: step.lastError ?? null,
                            previousParameters: (step.input ?? null) as Record<string, unknown> | null,
                            iteration,
                        });
                    } catch (err) {
                        const message = err instanceof Error ? err.message : String(err);
                        if (typeof message === "string" && message.startsWith("LLM_ERROR:")) {
                            // Do not execute any tool. Respect retry semantics for persistent loop.
                            const currentRetry = typeof latestTask.retryCount === "number" ? latestTask.retryCount + 1 : 1;
                            await this.updateTask(latestTask, {
                                lifecycleState: currentRetry <= (latestTask.maxRetries ?? 2) ? "retry_scheduled" : "failed",
                                status: currentRetry <= (latestTask.maxRetries ?? 2) ? "partial" : "failed",
                                retryCount: currentRetry,
                                maxRetries: latestTask.maxRetries ?? 2,
                            });

                            await this.updatePlanStepState(taskId, step.stepId, {
                                state: currentRetry <= (step.maxAttempts ?? 3) ? "retry_scheduled" : "failed",
                                lastError: message,
                            });

                            console.error("agent-runner llm:step-failure", { taskId, stepId: step.stepId, message });

                            if (currentRetry <= (latestTask.maxRetries ?? 2)) {
                                // break out to allow scheduler to retry later
                                await this.appendCheckpoint(latestTask, { step: "failed", status: "completed" });
                                await this.releaseTaskLeaseFn(taskId, this.workerId);
                                return {
                                    completed: false,
                                    retryCount: currentRetry,
                                    maxRetries: latestTask.maxRetries ?? 2,
                                    result: null,
                                    verification: null,
                                };
                            }

                            // exceeded retries -> fail the task
                            await this.appendCheckpoint(latestTask, { step: "failed", status: "completed" });
                            await this.transitionLifecycle(latestTask, "failed");
                            break;
                        }

                        throw err;
                    }

                    if (decision.needsClarification) {
                        const clarificationQuestion = decision.clarificationQuestion ?? "Please provide more details.";
                        await this.updatePlanStepState(taskId, step.stepId, {
                            state: "blocked",
                            lastError: clarificationQuestion,
                            output: {
                                summary: "Clarification required",
                                data: { clarificationQuestion },
                            },
                        });

                        await this.pauseForClarification(latestTask, clarificationQuestion, step.stepId);
                        return {
                            completed: false,
                            retryCount: typeof latestTask.retryCount === "number" ? latestTask.retryCount : 0,
                            maxRetries: typeof latestTask.maxRetries === "number" ? latestTask.maxRetries : 2,
                            result: lastResult,
                            verification: lastVerification,
                        };
                    }

                    if (!decision.toolName || decision.toolName === "none") {
                        await this.updatePlanStepState(taskId, step.stepId, {
                            state: "failed",
                            lastError: "LLM returned no executable tool.",
                        });
                        await this.transitionLifecycle(latestTask, "failed");
                        break;
                    }

                    const selectedTool = this.toolRegistry.get(decision.toolName);
                    if (!selectedTool) {
                        throw new Error(`No tool registered for name ${decision.toolName}`);
                    }

                    const resolvedInput = resolveStepTemplates(step.input ?? {}, previousStepOutputs);
                    const resolvedDecisionInput = resolveStepTemplates(decision.toolInput, previousStepOutputs);
                    const mergedInput = {
                        ...(resolvedInput && typeof resolvedInput === "object" ? resolvedInput as Record<string, unknown> : {}),
                        ...(resolvedDecisionInput && typeof resolvedDecisionInput === "object" ? resolvedDecisionInput as Record<string, unknown> : {}),
                    };
                    const normalizedInput = normalizeParams(decision.toolName, mergedInput);
                    const validationError = validateToolParameters(selectedTool, normalizedInput);
                    if (validationError) {
                        await this.updatePlanStepState(taskId, step.stepId, {
                            state: (step.attempts ?? 0) + 1 < (step.maxAttempts ?? 3) ? "retry_scheduled" : "failed",
                            lastError: validationError,
                        });

                        if ((step.attempts ?? 0) + 1 < (step.maxAttempts ?? 3)) {
                            await this.transitionLifecycle(latestTask, "retry_scheduled");
                            await waitForSignal(this.getBackoffDelay((step.attempts ?? 0) + 1), this.currentExecutionSignal ?? undefined);
                            await this.transitionLifecycle(latestTask, "ready");
                            continue;
                        }

                        await this.transitionLifecycle(latestTask, "failed");
                        break;
                    }

                    const selectedToolName = decision.toolName ?? "none";
                    let activeDecision = decision;
                    let activeToolName = selectedToolName;
                    let activeNormalizedInput = normalizedInput;

                    const attemptNumber = (step.attempts ?? 0) + 1;
                    const idempotencyKey = this.buildIdempotencyKey(taskId, step.stepId, attemptNumber);

                    let executionPayload: ExecutionActionRecord = {
                        taskId,
                        conversationId: latestTask.conversationId.toString(),
                        toolName: activeToolName,
                        parameters: activeNormalizedInput,
                        messageId: null,
                        executionState: "running",
                        stepId: step.stepId,
                        attempt: attemptNumber,
                        idempotencyKey,
                    };

                    await this.updatePlanStepState(taskId, step.stepId, {
                        selectedToolName: activeToolName,
                        input: activeNormalizedInput,
                        lastError: null,
                    });

                    let executed = await this.execute(executionPayload);

                    if ((!executed.adapterSuccess || executed.error) && (step.attempts ?? 0) < (step.maxAttempts ?? 3)) {
                        try {
                            const correctedDecision = await this.decideStepAction({
                                task: latestTask,
                                step,
                                rankedTools,
                                shortTermMemory: memory.shortTerm as Array<Record<string, unknown>>,
                                longTermMemory: memory.longTerm as Array<Record<string, unknown>>,
                                previousStepOutputs,
                                clarificationReply,
                                previousError: executed.error ?? "Execution failed",
                                previousParameters: activeNormalizedInput,
                                iteration: iteration + 1,
                            });

                            if (correctedDecision.needsClarification) {
                                const clarificationQuestion = correctedDecision.clarificationQuestion ?? "Please provide more details.";
                                await this.updatePlanStepState(taskId, step.stepId, {
                                    state: "blocked",
                                    lastError: clarificationQuestion,
                                    output: {
                                        summary: "Clarification required",
                                        data: { clarificationQuestion },
                                    },
                                });

                                await this.pauseForClarification(latestTask, clarificationQuestion, step.stepId);
                                return {
                                    completed: false,
                                    retryCount: typeof latestTask.retryCount === "number" ? latestTask.retryCount : 0,
                                    maxRetries: typeof latestTask.maxRetries === "number" ? latestTask.maxRetries : 2,
                                    result: lastResult,
                                    verification: lastVerification,
                                };
                            }

                            if (correctedDecision.toolName && correctedDecision.toolName !== "none") {
                                const correctedTool = this.toolRegistry.get(correctedDecision.toolName);
                                if (correctedTool) {
                                    const correctedResolvedInput = resolveStepTemplates(step.input ?? {}, previousStepOutputs);
                                    const correctedResolvedDecisionInput = resolveStepTemplates(correctedDecision.toolInput, previousStepOutputs);
                                    const correctedMergedInput = {
                                        ...(correctedResolvedInput && typeof correctedResolvedInput === "object" ? correctedResolvedInput as Record<string, unknown> : {}),
                                        ...(correctedResolvedDecisionInput && typeof correctedResolvedDecisionInput === "object" ? correctedResolvedDecisionInput as Record<string, unknown> : {}),
                                    };
                                    const correctedNormalizedInput = normalizeParams(correctedDecision.toolName, correctedMergedInput);
                                    const correctedValidationError = validateToolParameters(correctedTool, correctedNormalizedInput);

                                    if (!correctedValidationError) {
                                        activeDecision = correctedDecision;
                                        activeToolName = correctedDecision.toolName;
                                        activeNormalizedInput = correctedNormalizedInput;
                                        executionPayload = {
                                            ...executionPayload,
                                            toolName: activeToolName,
                                            parameters: activeNormalizedInput,
                                            idempotencyKey: this.buildIdempotencyKey(taskId, step.stepId, attemptNumber + 1),
                                        };

                                        await this.updatePlanStepState(taskId, step.stepId, {
                                            selectedToolName: activeToolName,
                                            input: activeNormalizedInput,
                                            lastError: null,
                                        });

                                        executed = await this.execute(executionPayload);
                                    }
                                }
                            }
                        } catch (retryErr) {
                            console.error("agent-runner llm:self-heal-failed", {
                                taskId,
                                stepId: step.stepId,
                                message: retryErr instanceof Error ? retryErr.message : String(retryErr),
                            });
                        }
                    }

                    lastResult = await this.observe({
                        task: latestTask,
                        action: executionPayload,
                        retryCount: typeof latestTask.retryCount === "number" ? latestTask.retryCount : 0,
                        maxRetries: typeof latestTask.maxRetries === "number" ? latestTask.maxRetries : 2,
                        attemptPayload: executionPayload,
                        observed: executed,
                        verification: null,
                    }, executed);

                    lastVerification = await this.verify(lastResult, {
                        task: latestTask,
                        action: executionPayload,
                        retryCount: typeof latestTask.retryCount === "number" ? latestTask.retryCount : 0,
                        maxRetries: typeof latestTask.maxRetries === "number" ? latestTask.maxRetries : 2,
                        attemptPayload: executionPayload,
                        observed: lastResult,
                        verification: null,
                    });

                    if (lastVerification.success) {
                        await this.updatePlanStepState(taskId, step.stepId, {
                            state: "completed",
                            completedAt: new Date(),
                            selectedToolName: activeDecision.toolName,
                            output: {
                                summary: lastResult.summary,
                                data: lastResult.evidence,
                                confidence: lastVerification.confidence,
                            },
                        });

                        if (plan.steps.every((entry) => entry.state === "completed")) {
                            await this.transitionLifecycle(latestTask, "completed");
                            await this.updateTask(latestTask, {
                                status: "completed",
                                progress: 100,
                                result: {
                                    success: true,
                                    confidence: lastVerification.confidence,
                                    evidence: {
                                        previousStepOutputs,
                                        finalStepId: step.stepId,
                                        execution: lastResult.evidence,
                                    },
                                },
                            });
                            break;
                        }

                        continue;
                    }

                    const attempted = (step.attempts ?? 0) + 1;

                    if (attempted < (step.maxAttempts ?? 3)) {
                        await this.updatePlanStepState(taskId, step.stepId, {
                            state: "retry_scheduled",
                            selectedToolName: activeToolName,
                            lastError: lastResult.error ?? "Execution failed",
                        });

                        await this.transitionLifecycle(latestTask, "retry_scheduled");
                        await waitForSignal(this.getBackoffDelay(attempted), this.currentExecutionSignal ?? undefined);
                        await this.transitionLifecycle(latestTask, "ready");
                        continue;
                    }

                    await this.updatePlanStepState(taskId, step.stepId, {
                        state: "failed",
                        selectedToolName: activeToolName,
                        lastError: lastResult.error ?? "Verification failed",
                        output: {
                            summary: lastResult.summary,
                            data: lastResult.evidence,
                            confidence: lastVerification.confidence,
                        },
                    });

                    await this.transitionLifecycle(latestTask, "failed");
                    await this.appendCheckpoint(latestTask, {
                        step: "adjust",
                        status: "failed",
                    });
                    break;
                } finally {
                    clearTimeout(iterationTimeoutHandle);
                    this.currentExecutionSignal = runAbortController.signal;
                }
            }

            const finalTask = await this.taskModel.findById(taskId);
            if (!finalTask) {
                throw new Error(`Task disappeared before finalization: ${taskId}`);
            }

            const outcome = (finalTask.lifecycleState ?? "ready") === "completed";
            await this.generateAndStoreReflectionFn({
                taskId,
                conversationId: finalTask.conversationId.toString(),
                runId: null,
                title: finalTask.title,
                outcome: outcome ? "completed" : (finalTask.lifecycleState === "failed" ? "failed" : "partial"),
                executionSummary: lastResult?.summary ?? (outcome ? "Task completed." : "Task failed."),
                toolName: lastResult && typeof (lastResult.evidence as Record<string, unknown>)?.toolName === "string"
                    ? (lastResult.evidence as Record<string, unknown>).toolName as string
                    : null,
            });

            return {
                completed: outcome,
                retryCount: typeof finalTask.retryCount === "number" ? finalTask.retryCount : 0,
                maxRetries: typeof finalTask.maxRetries === "number" ? finalTask.maxRetries : 2,
                result: lastResult,
                verification: lastVerification,
            };
        } finally {
            watchdog.stop();
            this.currentExecutionSignal = null;
            await this.releaseTaskLeaseFn(taskId, this.workerId);
        }
    }

    private startLeaseWatchdog(taskId: string, runAbortController: AbortController, runId: string, intervalMs: number) {
        let stopped = false;
        let timer: ReturnType<typeof setTimeout> | null = null;

        const schedule = () => {
            if (stopped || runAbortController.signal.aborted) {
                return;
            }

            timer = setTimeout(async () => {
                if (stopped || runAbortController.signal.aborted) {
                    return;
                }

                try {
                    const lease = await this.heartbeatTaskLeaseFn(taskId, this.workerId);
                    if (!lease) {
                        console.warn("agent-runner lease:lost", { runId, taskId, workerId: this.workerId });
                        runAbortController.abort();
                        return;
                    }
                } catch (error) {
                    console.warn("agent-runner lease:lost", {
                        runId,
                        taskId,
                        workerId: this.workerId,
                        error: error instanceof Error ? error.message : String(error),
                    });
                    runAbortController.abort();
                    return;
                }

                schedule();
            }, intervalMs);
        };

        schedule();

        return {
            stop: () => {
                stopped = true;
                if (timer) {
                    clearTimeout(timer);
                }
            },
        };
    }

    private getCurrentRunId() {
        return this.currentRunId ?? `run-${Date.now()}`;
    }

    private getToolTimeoutMs() {
        return Math.max(1000, Number(process.env.TASK_AGENT_TOOL_TIMEOUT_MS || 60000));
    }

    private buildIdempotencyKey(taskId: string, stepId: string, attempt: number) {
        return `${taskId}:${stepId}:${attempt}`;
    }

    private async observe(_context: LoopContext, result: ActionExecutionResult): Promise<ActionExecutionResult> {
        console.log("agent-runner step:observe", {
            runId: this.currentRunId,
            summary: result.summary,
            adapterSuccess: result.adapterSuccess,
        });

        return result;
    }

    private async execute(payload: ExecutionActionRecord): Promise<ActionExecutionResult> {
        const tool = this.toolRegistry.get(payload.toolName);
        const runId = this.getCurrentRunId();
        const toolTimeoutMs = this.getToolTimeoutMs();

        console.log("agent-runner step:execute", {
            runId,
            stepId: payload.stepId ?? null,
            attempt: payload.attempt ?? null,
            idempotencyKey: payload.idempotencyKey ?? null,
            taskId: payload.taskId,
            toolName: payload.toolName,
            parameters: payload.parameters,
        });

        if (!tool) {
            return {
                summary: `No tool registered for name ${payload.toolName}.`,
                adapterSuccess: false,
                evidence: { toolName: payload.toolName },
                error: `No tool registered for name ${payload.toolName}`,
            };
        }

        try {
            const parsedInput = tool.inputSchema.parse(payload.parameters ?? {});
            const startedAt = Date.now();
            const timeoutController = new AbortController();
            const timeoutHandle = setTimeout(() => timeoutController.abort(), toolTimeoutMs);
            const signal = combineAbortSignals(this.currentExecutionSignal ?? undefined, timeoutController.signal) ?? timeoutController.signal;

            try {
                const result = await tool.execute(parsedInput, {
                    taskId: payload.taskId,
                    conversationId: payload.conversationId,
                    messageId: payload.messageId,
                    signal,
                    metadata: {
                        runId,
                        stepId: payload.stepId ?? undefined,
                        attempt: payload.attempt ?? undefined,
                        idempotencyKey: payload.idempotencyKey ?? undefined,
                    },
                });

                console.log("agent-runner step:tool-execute", {
                    runId,
                    stepId: payload.stepId ?? null,
                    toolName: tool.name,
                    success: result.adapterSuccess,
                    idempotencyKey: payload.idempotencyKey ?? null,
                    latencyMs: Date.now() - startedAt,
                });

                return {
                    ...result,
                    evidence: {
                        toolName: tool.name,
                        result: result.evidence,
                        metadata: {
                            runId,
                            stepId: payload.stepId ?? null,
                            attempt: payload.attempt ?? null,
                            idempotencyKey: payload.idempotencyKey ?? null,
                        },
                    },
                };
            } finally {
                clearTimeout(timeoutHandle);
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : "unknown tool error";
            if (this.currentExecutionSignal?.aborted || /abort|timed out|lease lost/i.test(message)) {
                throw new Error(message.includes("timed out") ? message : "Execution aborted.");
            }
            console.warn("agent-runner step:tool-failure", {
                runId,
                stepId: payload.stepId ?? null,
                taskId: payload.taskId,
                toolName: tool.name,
                reason: message,
                idempotencyKey: payload.idempotencyKey ?? null,
            });

            return {
                summary: `Tool ${tool.name} failed.`,
                adapterSuccess: false,
                evidence: {
                    toolName: tool.name,
                    metadata: {
                        runId,
                        stepId: payload.stepId ?? null,
                        attempt: payload.attempt ?? null,
                        idempotencyKey: payload.idempotencyKey ?? null,
                    },
                    reason: message,
                },
                error: message,
            };
        }
    }

    private async verify(result: ActionExecutionResult, context: LoopContext): Promise<VerificationOutcome> {
        const validationLog = this.taskSuccessRegistry.validate(context.action.toolName as TaskExecutionActionType, context.task, result);
        const passedChecks = validationLog.checks.filter((check) => check.passed).length;
        const totalChecks = validationLog.checks.length;
        const confidence = totalChecks > 0 ? passedChecks / totalChecks : (validationLog.passed ? 1 : 0);

        console.log("agent-runner step:verify", {
            toolName: context.action.toolName,
            evidence: result.evidence,
            validator: validationLog.validator,
            passed: validationLog.passed,
            checks: validationLog.checks,
        });

        return {
            success: validationLog.passed,
            confidence,
            validationLog,
        };
    }

    private async adjust(context: LoopContext, result: ActionExecutionResult | null, verification: VerificationOutcome): Promise<ExecutionActionRecord> {
        const nextParameters = { ...(context.attemptPayload.parameters ?? {}) };

        if (context.action.toolName === "send_email") {
            nextParameters.subject = typeof nextParameters.subject === "string" && nextParameters.subject.trim().length > 0
                ? nextParameters.subject
                : `${context.task.title} - follow up`;
            nextParameters.body = typeof nextParameters.body === "string" && nextParameters.body.trim().length > 0
                ? nextParameters.body
                : `${context.task.description || context.task.title}`;
            if (!nextParameters.to && process.env.RESEND_FROM_EMAIL) {
                nextParameters.to = [process.env.RESEND_FROM_EMAIL];
            }
        }

        if (context.action.toolName === "schedule_meeting") {
            nextParameters.summary = typeof nextParameters.summary === "string" && nextParameters.summary.trim().length > 0
                ? nextParameters.summary
                : context.task.title;
            nextParameters.notes = typeof nextParameters.notes === "string" && nextParameters.notes.trim().length > 0
                ? nextParameters.notes
                : context.task.description || context.task.title;
            if (!nextParameters.whenText) {
                nextParameters.whenText = "next available slot";
            }
        }

        if (context.action.toolName === "create_github_issue") {
            nextParameters.title = typeof nextParameters.title === "string" && nextParameters.title.trim().length > 0
                ? nextParameters.title
                : context.task.title;
            nextParameters.body = typeof nextParameters.body === "string" && nextParameters.body.trim().length > 0
                ? nextParameters.body
                : context.task.description || context.task.title;
            if (!Array.isArray(nextParameters.labels)) {
                nextParameters.labels = ["retry-adjusted"];
            }
        }

        const adjusted = {
            ...context.attemptPayload,
            parameters: nextParameters,
        };

        console.log("agent-runner step:adjust", {
            taskId: context.task._id.toString(),
            toolName: context.action.toolName,
            retryCount: context.retryCount,
            verificationConfidence: verification.confidence,
            adjustedParameters: nextParameters,
            previousSummary: result?.summary ?? null,
        });

        return adjusted;
    }

    private getBackoffDelay(retryCount: number) {
        const schedule = [1000, 2000, 5000] as const;
        return schedule[Math.min(Math.max(retryCount - 1, 0), schedule.length - 1)] ?? 0;
    }

    private mapToolNameToActionType(toolName?: string | null): TaskExecutionActionType {
        if (!toolName) return "none";
        try {
            const tool = this.toolRegistry.get(toolName);
            if (tool) return toolName as TaskExecutionActionType;
        } catch {
            // ignore
        }
        return "none";
    }

    private summarizeEvidence(evidence: unknown): unknown {
        if (evidence === null || evidence === undefined) return null;
        if (typeof evidence === "string") return evidence.length > 1000 ? `${evidence.slice(0, 1000)}...` : evidence;
        if (Array.isArray(evidence)) {
            return {
                type: "array",
                length: evidence.length,
                sample: evidence.length > 0 ? evidence[0] : null,
            };
        }
        if (typeof evidence === "object") {
            try {
                const asRecord = evidence as Record<string, unknown>;
                const keys = Object.keys(asRecord).slice(0, 5);
                const summary: Record<string, unknown> = {};
                for (const k of keys) summary[k] = asRecord[k];
                summary._keys = Object.keys(asRecord).length;
                return summary;
            } catch {
                return "[evidence]";
            }
        }
        return String(evidence).slice(0, 1000);
    }

    private async updateTask(task: TaskDocumentLike, patch: {
        status?: string;
        lifecycleState?: "planning" | "ready" | "executing" | "waiting_for_approval" | "blocked" | "retry_scheduled" | "paused" | "completed" | "failed";
        retryCount?: number;
        maxRetries?: number;
        currentStepId?: string | null;
        iterationCount?: number;
        progress?: number;
        checkpoints?: TaskCheckpoint[];
        executionHistory?: TaskExecutionHistory;
        result?: TaskResult;
        pausedReason?: string | null;
        blockedReason?: string | null;
    }) {
        const previousVersion = task.version;
        let changed = false;

        if (patch.status !== undefined && task.status !== patch.status) {
            task.status = patch.status;
            changed = true;
        }
        if (patch.lifecycleState !== undefined && task.lifecycleState !== patch.lifecycleState) {
            task.lifecycleState = patch.lifecycleState;
            changed = true;
        }
        if (patch.retryCount !== undefined && task.retryCount !== patch.retryCount) {
            task.retryCount = patch.retryCount;
            changed = true;
        }
        if (patch.maxRetries !== undefined && task.maxRetries !== patch.maxRetries) {
            task.maxRetries = patch.maxRetries;
            changed = true;
        }
        if (patch.currentStepId !== undefined && task.currentStepId !== patch.currentStepId) {
            task.currentStepId = patch.currentStepId;
            changed = true;
        }
        if (patch.iterationCount !== undefined && task.iterationCount !== patch.iterationCount) {
            task.iterationCount = patch.iterationCount;
            changed = true;
        }
        if (patch.progress !== undefined && task.progress !== patch.progress) {
            task.progress = patch.progress;
            changed = true;
        }
        if (patch.checkpoints !== undefined && JSON.stringify(task.checkpoints ?? []) !== JSON.stringify(patch.checkpoints)) {
            task.checkpoints = patch.checkpoints;
            changed = true;
        }
        if (patch.executionHistory !== undefined && JSON.stringify(task.executionHistory ?? null) !== JSON.stringify(patch.executionHistory)) {
            task.executionHistory = patch.executionHistory;
            changed = true;
        }
        if (patch.result !== undefined && JSON.stringify(task.result ?? null) !== JSON.stringify(patch.result)) {
            task.result = patch.result;
            changed = true;
        }
        if (patch.pausedReason !== undefined && task.pausedReason !== patch.pausedReason) {
            task.pausedReason = patch.pausedReason;
            changed = true;
        }
        if (patch.blockedReason !== undefined && task.blockedReason !== patch.blockedReason) {
            task.blockedReason = patch.blockedReason;
            changed = true;
        }

        if (!changed) {
            return task;
        }

        task.updatedBy = null;
        await task.save();

        const payload: TaskUpdatedPayload = {
            taskId: task._id.toString(),
            conversationId: task.conversationId.toString(),
            patch: {
                ...(patch.status !== undefined ? { status: patch.status as any } : {}),
                ...(patch.lifecycleState !== undefined ? { lifecycleState: patch.lifecycleState as any } : {}),
                ...(patch.retryCount !== undefined ? { retryCount: patch.retryCount } : {}),
                ...(patch.maxRetries !== undefined ? { maxRetries: patch.maxRetries } : {}),
                ...(patch.currentStepId !== undefined ? { currentStepId: patch.currentStepId } : {}),
                ...(patch.iterationCount !== undefined ? { iterationCount: patch.iterationCount } : {}),
                ...(patch.progress !== undefined ? { progress: patch.progress } : {}),
                ...(patch.checkpoints !== undefined ? { checkpoints: patch.checkpoints } : {}),
                ...(patch.executionHistory !== undefined ? { executionHistory: patch.executionHistory } : {}),
                ...(patch.result !== undefined ? { result: patch.result } : {}),
                ...(patch.pausedReason !== undefined ? { pausedReason: patch.pausedReason } : {}),
                ...(patch.blockedReason !== undefined ? { blockedReason: patch.blockedReason } : {}),
                updatedBy: null,
            },
            previousVersion,
            newVersion: task.version,
            updatedByType: "agent",
            updatedById: null,
        };

        await this.emitTaskUpdated(task.conversationId.toString(), payload);
        return task;
    }

    private async emitTaskUpdated(conversationId: string, payload: TaskUpdatedPayload) {
        const internalSecret = process.env.INTERNAL_SECRET || "";
        await fetch(`${this.internalBaseUrl}/internal/task-updated`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                ...(internalSecret ? { [INTERNAL_SECRET_HEADER]: internalSecret } : {}),
            },
            body: JSON.stringify({
                conversationId,
                payload,
            }),
        });
    }
}
export default AgentRunner;
