import * as dbModule from "@chat/db";
import TaskReflectionModel from "@chat/db/models/TaskReflection";
import { writeLongTermMemory, writeShortTermMemory } from "./memory-service.js";
import { createDefaultLLMProvider } from "./llm/index.js";
import { parseJsonResponse } from "./llm/response-parser.js";

const connectToDatabase =
    (dbModule as unknown as { connectToDatabase?: () => Promise<unknown> }).connectToDatabase
    || ((dbModule as unknown as { default?: { connectToDatabase?: () => Promise<unknown> } }).default?.connectToDatabase)
    || (async () => undefined);

const DEFAULT_REFLECTION_MODEL = process.env.TASK_REFLECTION_MODEL || "gpt-4o-mini";

function fallbackReflection(input: {
    taskId: string;
    outcome: "completed" | "failed" | "partial";
    executionSummary: string;
}) {
    return {
        whatWorked: input.outcome === "completed"
            ? ["Execution loop reached a terminal success state."]
            : ["Execution history was recorded for troubleshooting."],
        whatFailed: input.outcome === "completed"
            ? []
            : [input.executionSummary || "Task did not meet verification criteria."],
        improvements: ["Improve plan quality for step decomposition and fallback selection."],
        confidence: input.outcome === "completed" ? 0.75 : 0.45,
    };
}

async function llmReflection(input: {
    taskId: string;
    title: string;
    outcome: "completed" | "failed" | "partial";
    executionSummary: string;
    toolName?: string | null;
}) {
    try {
        const provider = createDefaultLLMProvider();
        const response = await provider.generate({
            model: DEFAULT_REFLECTION_MODEL,
            input: [
                {
                    role: "system",
                    content: "Return one JSON object only with whatWorked (string[]), whatFailed (string[]), improvements (string[]), confidence (0-1 number).",
                },
                {
                    role: "user",
                    content: JSON.stringify(input),
                },
            ],
            temperature: 0.1,
        });

        const parsed = parseJsonResponse<Record<string, unknown>>(response);
        if (!parsed.value) return null;

        const record = parsed.value;
        return {
            whatWorked: Array.isArray(record.whatWorked)
                ? record.whatWorked.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
                : [],
            whatFailed: Array.isArray(record.whatFailed)
                ? record.whatFailed.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
                : [],
            improvements: Array.isArray(record.improvements)
                ? record.improvements.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
                : [],
            confidence: typeof record.confidence === "number"
                ? Math.max(0, Math.min(1, record.confidence))
                : 0.5,
        };
    } catch {
        return null;
    }
}

export async function generateAndStoreReflection(input: {
    taskId: string;
    conversationId: string;
    runId?: string | null;
    title: string;
    outcome: "completed" | "failed" | "partial";
    executionSummary: string;
    toolName?: string | null;
}) {
    await connectToDatabase();

    const generated = await llmReflection(input) ?? fallbackReflection(input);

    const reflection = await TaskReflectionModel.create({
        taskId: input.taskId,
        conversationId: input.conversationId,
        runId: input.runId ?? null,
        outcome: input.outcome,
        whatWorked: generated.whatWorked,
        whatFailed: generated.whatFailed,
        improvements: generated.improvements,
        confidence: generated.confidence,
        generatedByModel: DEFAULT_REFLECTION_MODEL,
    });

    await writeShortTermMemory({
        taskId: input.taskId,
        conversationId: input.conversationId,
        kind: input.outcome === "completed" ? "pattern" : "failure",
        summary: `Reflection(${input.outcome}): ${generated.improvements[0] ?? "No improvement noted."}`,
        details: input.executionSummary,
        tags: ["reflection", input.outcome],
        signalStrength: generated.confidence,
        successImpact: input.outcome === "completed" ? 0.4 : -0.3,
        toolName: input.toolName ?? undefined,
    });

    if (generated.improvements.length > 0) {
        await writeLongTermMemory({
            conversationId: input.conversationId,
            kind: "strategy",
            summary: generated.improvements[0],
            details: generated.improvements.join("\n"),
            tags: ["reflection", "strategy"],
            signalStrength: generated.confidence,
            successImpact: input.outcome === "completed" ? 0.3 : -0.2,
            toolName: input.toolName ?? undefined,
        });
    }

    return reflection;
}
