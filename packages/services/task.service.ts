import type { CreateTaskInput } from "./validators/task.schema";
import { buildTaskDedupeKey, createTask, upsertTaskByDedupeKey } from "./repositories/task.repo";

export function normalizeTaskTitle(title: string) {
    return title.trim().replace(/\s+/g, " ");
}

export function deriveTaskDedupeKey(
    input: Pick<CreateTaskInput, "conversationId" | "title"> & {
        sourceMessageId?: string | null;
        toolName?: string;
        parameters?: Record<string, unknown>;
    }
) {
    const toolName = input.toolName ?? "manual";
    const parameters = input.parameters ?? {
        title: normalizeTaskTitle(input.title).toLowerCase(),
    };

    return buildTaskDedupeKey(input.conversationId, toolName, parameters, input.sourceMessageId ?? null);
}

export async function createOrReuseTask(input: CreateTaskInput) {
    return upsertTaskByDedupeKey(input);
}

export async function createManualTask(input: CreateTaskInput) {
    return createTask(input);
}