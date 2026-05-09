import * as dbModule from "@chat/db";
import TaskPlanModel, { type ITaskStep } from "@chat/db/models/TaskPlan";
import type { PlannerContext } from "@chat/types";
import { createDefaultLLMProvider } from "./llm/index.js";
import { parseJsonText } from "./llm/response-parser.js";

const connectToDatabase =
    (dbModule as unknown as { connectToDatabase?: () => Promise<unknown> }).connectToDatabase
    || ((dbModule as unknown as { default?: { connectToDatabase?: () => Promise<unknown> } }).default?.connectToDatabase)
    || (async () => undefined);

const DEFAULT_PLANNER_MODEL = process.env.TASK_PLANNER_MODEL || "gpt-4o-mini";
const DEFAULT_PLANNER_VERSION = "planner-v1";

type PlannerLlmRequest = { model: string; input: string };
type PlannerLlmResponse = { output_text?: string; output?: unknown };
type PlannerLlmRequestFn = (request: PlannerLlmRequest) => Promise<PlannerLlmResponse>;
type CreateOrRefreshTaskPlanOptions = { llmRequestFn?: PlannerLlmRequestFn };

function buildFallbackPlan(context: PlannerContext): { goal: string; successDefinition: string; steps: ITaskStep[] } {
    const toolCandidates = context.availableTools.slice(0, 3).map((tool) => ({
        toolName: tool.name,
        confidence: 0.5,
        riskLevel: "medium" as const,
    }));

    return {
        goal: context.title,
        successDefinition: "Task reaches successful completion with verified adapter output.",
        steps: [
            {
                stepId: "step-1-prepare",
                title: "Prepare execution context",
                description: "Validate required input and collect missing context.",
                kind: "decision",
                order: 1,
                dependencies: [],
                fallbackPolicy: "dependency_preserving",
                overrideDependencies: false,
                fallback: [],
                successCriteria: ["Required execution inputs are available."],
                toolCandidates: [],
                selectedToolName: null,
                input: {},
                output: {},
                state: "ready",
                attempts: 0,
                maxAttempts: 2,
                lastError: null,
                startedAt: null,
                completedAt: null,
            },
            {
                stepId: "step-2-act",
                title: "Execute primary action",
                description: context.description || context.title,
                kind: "tool_call",
                order: 2,
                dependencies: ["step-1-prepare"],
                fallbackPolicy: "dependency_preserving",
                overrideDependencies: false,
                fallback: [],
                successCriteria: ["Selected tool returns success.", "Validator checks pass."],
                toolCandidates,
                selectedToolName: null,
                input: {},
                output: {},
                state: "ready",
                attempts: 0,
                maxAttempts: 3,
                lastError: null,
                startedAt: null,
                completedAt: null,
            },
            {
                stepId: "step-3-verify",
                title: "Verify and close",
                description: "Validate outcomes and mark the task completed.",
                kind: "validation",
                order: 3,
                dependencies: ["step-2-act"],
                fallbackPolicy: "dependency_preserving",
                overrideDependencies: false,
                fallback: [],
                successCriteria: ["Verification confidence >= 0.8", "No unresolved errors remain."],
                toolCandidates: [],
                selectedToolName: null,
                input: {},
                output: {},
                state: "ready",
                attempts: 0,
                maxAttempts: 2,
                lastError: null,
                startedAt: null,
                completedAt: null,
            },
        ],
    };
}

function extractJsonObject(raw: string): Record<string, unknown> | null {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start < 0 || end <= start) return null;

    const candidate = raw.slice(start, end + 1);
    try {
        const parsed = JSON.parse(candidate) as unknown;
        if (parsed && typeof parsed === "object") {
            return parsed as Record<string, unknown>;
        }
        return null;
    } catch {
        const repaired = parseJsonText<Record<string, unknown>>(candidate);
        return repaired.value && typeof repaired.value === "object" ? repaired.value : null;
    }
}

function parsePlannedSteps(payload: unknown): ITaskStep[] {
    if (!Array.isArray(payload)) return [];

    const parsed: ITaskStep[] = [];
    for (let index = 0; index < payload.length; index += 1) {
        const raw = payload[index] as Record<string, unknown>;
        const stepId = typeof raw.stepId === "string" && raw.stepId.trim().length > 0
            ? raw.stepId.trim()
            : `step-${index + 1}`;

        const title = typeof raw.title === "string" && raw.title.trim().length > 0
            ? raw.title.trim()
            : `Step ${index + 1}`;

        const description = typeof raw.description === "string" && raw.description.trim().length > 0
            ? raw.description.trim()
            : title;

        const dependencies = Array.isArray(raw.dependencies)
            ? raw.dependencies.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
            : [];

        const fallback = Array.isArray(raw.fallback)
            ? raw.fallback
                .map((entry) => {
                    if (!entry || typeof entry !== "object") return null;
                    const record = entry as Record<string, unknown>;
                    if (typeof record.stepId !== "string" || record.stepId.length === 0) return null;
                    return {
                        stepId: record.stepId,
                        reason: typeof record.reason === "string" ? record.reason : "Fallback selected by planner.",
                    };
                })
                .filter((entry): entry is { stepId: string; reason: string } => Boolean(entry))
            : [];

        const toolCandidates = Array.isArray(raw.toolCandidates)
            ? raw.toolCandidates
                .map((entry) => {
                    if (!entry || typeof entry !== "object") return null;
                    const candidate = entry as Record<string, unknown>;
                    if (typeof candidate.toolName !== "string" || candidate.toolName.length === 0) return null;
                    const confidence = typeof candidate.confidence === "number" ? candidate.confidence : 0.5;
                    const riskLevel = candidate.riskLevel === "low" || candidate.riskLevel === "medium" || candidate.riskLevel === "high"
                        ? candidate.riskLevel
                        : "medium";
                    return {
                        toolName: candidate.toolName,
                        confidence: Math.max(0, Math.min(1, confidence)),
                        riskLevel,
                    };
                })
                .filter((entry): entry is { toolName: string; confidence: number; riskLevel: "low" | "medium" | "high" } => Boolean(entry))
            : [];

        const successCriteria = Array.isArray(raw.successCriteria)
            ? raw.successCriteria.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
            : [];

        const input = raw.input && typeof raw.input === "object" && !Array.isArray(raw.input)
            ? (raw.input as Record<string, unknown>)
            : {};

        const output = raw.output && typeof raw.output === "object" && !Array.isArray(raw.output)
            ? (raw.output as Record<string, unknown>)
            : {};

        parsed.push({
            stepId,
            title,
            description,
            kind: raw.kind === "tool_call" || raw.kind === "decision" || raw.kind === "approval" || raw.kind === "notification" || raw.kind === "validation"
                ? raw.kind
                : "tool_call",
            order: index + 1,
            dependencies,
            fallbackPolicy: raw.fallbackPolicy === "immediate_execution" ? "immediate_execution" : "dependency_preserving",
            overrideDependencies: raw.overrideDependencies === true,
            fallback,
            successCriteria,
            toolCandidates,
            selectedToolName: null,
            input,
            output,
            state: "ready",
            attempts: 0,
            maxAttempts: typeof raw.maxAttempts === "number" && raw.maxAttempts > 0 ? Math.floor(raw.maxAttempts) : 3,
            lastError: null,
            startedAt: null,
            completedAt: null,
        });
    }

    return parsed;
}

function extractLlmResponseText(response: PlannerLlmResponse): string {
    if (typeof response.output_text === "string" && response.output_text.trim().length > 0) {
        return response.output_text;
    }

    if (!Array.isArray(response.output)) return "";

    for (const item of response.output) {
        if (!item || typeof item !== "object") continue;
        const content = (item as { content?: unknown }).content;
        if (!Array.isArray(content)) continue;

        for (const part of content) {
            if (!part || typeof part !== "object") continue;
            const text = (part as { text?: unknown }).text;
            if (typeof text === "string" && text.trim().length > 0) {
                return text;
            }
        }
    }

    return "";
}

async function requestPlanFromLlm(
    context: PlannerContext,
    options?: CreateOrRefreshTaskPlanOptions
): Promise<{ goal: string; successDefinition: string; steps: ITaskStep[] } | null> {
    const prompt = [
        "Return one JSON object only with keys: goal, successDefinition, steps.",
        "Each step must include: stepId, title, description, kind, dependencies, fallback, successCriteria, toolCandidates, input, output, maxAttempts.",
        "Keep steps minimal, dependency-aware, and executable one by one.",
        "Only use tools from availableTools.",
    ].join(" ");

    const taskPayload = JSON.stringify({
        taskId: context.taskId,
        title: context.title,
        description: context.description,
        availableTools: context.availableTools,
    });

    let content = "";

    if (options?.llmRequestFn) {
        try {
            const llmResponse = await options.llmRequestFn({ model: DEFAULT_PLANNER_MODEL, input: `${prompt}\n\n${taskPayload}` });
            content = extractLlmResponseText(llmResponse);
        } catch {
            content = "";
        }
    }

    if (!content) {
        try {
            const provider = createDefaultLLMProvider();
            const llmResponse = await provider.generate({
                model: DEFAULT_PLANNER_MODEL,
                input: [
                    { role: "system", content: prompt },
                    { role: "user", content: taskPayload },
                ],
                temperature: 0.1,
            });

            content = extractLlmResponseText(llmResponse);
        } catch {
            return null;
        }
    }

    const parsed = extractJsonObject(content);
    if (!parsed) return null;

    const steps = parsePlannedSteps(parsed.steps);
    if (steps.length === 0) return null;

    return {
        goal: typeof parsed.goal === "string" && parsed.goal.length > 0 ? parsed.goal : context.title,
        successDefinition: typeof parsed.successDefinition === "string" && parsed.successDefinition.length > 0
            ? parsed.successDefinition
            : "Execution succeeds and verification passes.",
        steps,
    };
}

export async function createOrRefreshTaskPlan(context: PlannerContext, options?: CreateOrRefreshTaskPlanOptions) {
    await connectToDatabase();

    const llmPlan = await requestPlanFromLlm(context, options);
    const plan = llmPlan ?? buildFallbackPlan(context);

    return TaskPlanModel.findOneAndUpdate(
        { taskId: context.taskId },
        {
            $set: {
                conversationId: context.conversationId,
                goal: plan.goal,
                successDefinition: plan.successDefinition,
                plannerModel: DEFAULT_PLANNER_MODEL,
                plannerVersion: DEFAULT_PLANNER_VERSION,
                status: "active",
                steps: plan.steps,
                activeStepId: plan.steps[0]?.stepId ?? null,
                planNotes: llmPlan ? "Generated by LLM planner." : "Fallback deterministic plan.",
            },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
    ).exec();
}

export async function getTaskPlan(taskId: string) {
    await connectToDatabase();
    return TaskPlanModel.findOne({ taskId }).exec();
}
