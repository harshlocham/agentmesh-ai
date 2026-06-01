import TaskModel from "@chat/db/models/Task";
import TaskExecutionEventModel, {
    type ITaskExecutionEvent,
    type TaskExecutionEventPhase,
    type TaskExecutionEventType,
} from "@chat/db/models/TaskExecutionEvent";
import type { TaskExecutionUpdatedPayload } from "@chat/types";
import { connectToDatabase } from "@chat/db";

async function allocateSequence(taskId: string, runId: string): Promise<number> {
    const updated = await TaskModel.findOneAndUpdate(
        { _id: taskId },
        { $inc: { executionEventSequence: 1 } },
        { new: true, projection: { executionEventSequence: 1 } }
    ).exec();

    if (!updated?.executionEventSequence) {
        throw new Error(`Unable to allocate execution event sequence for task ${taskId} and run ${runId}`);
    }

    return updated.executionEventSequence;
}

export async function appendExecutionEvent(input: {
    taskId: string;
    conversationId: string;
    runId: string;
    type: TaskExecutionEventType;
    phase: TaskExecutionEventPhase;
    payload?: Record<string, unknown>;
}): Promise<ITaskExecutionEvent> {
    await connectToDatabase();

    const sequence = await allocateSequence(input.taskId, input.runId);

    const doc = await TaskExecutionEventModel.create({
        taskId: input.taskId,
        conversationId: input.conversationId,
        runId: input.runId,
        sequence,
        type: input.type,
        phase: input.phase,
        payload: input.payload ?? {},
        createdAt: new Date(),
    });

    return doc;
}

export async function getExecutionEventsAfter(args: {
    taskId: string;
    afterSequence?: number;
    limit?: number;
    runId?: string;
}): Promise<ITaskExecutionEvent[]> {
    await connectToDatabase();

    const afterSequence = args.afterSequence ?? 0;
    const limit = Math.min(500, Math.max(1, args.limit ?? 200));

    const filter: Record<string, unknown> = {
        taskId: args.taskId,
        sequence: { $gt: afterSequence },
    };

    if (args.runId) {
        filter.runId = args.runId;
    }

    return TaskExecutionEventModel.find(filter)
        .sort({ sequence: 1 })
        .limit(limit)
        .lean()
        .exec() as Promise<ITaskExecutionEvent[]>;
}

function mapPayloadStateToEventType(
    state: TaskExecutionUpdatedPayload["state"],
    step?: string | null
): TaskExecutionEventType {
    if (step === "retry_scheduled" || step === "retry_started") {
        return step === "retry_started" ? "retry_started" : "retry_scheduled";
    }
    if (step === "approval_pending") {
        return "waiting_for_approval";
    }
    if (step === "needs_clarification") {
        return "waiting_for_input";
    }
    if (step === "decide_next_action" || step === "execute_tool") {
        return step === "execute_tool" ? "tool_started" : "tool_selected";
    }
    if (step === "verify_result" || step === "verification_completed") {
        return "verification";
    }
    if (step === "completed" || state === "succeeded") {
        return "execution_completed";
    }
    if (step === "failed" || step === "exception" || state === "failed") {
        return "execution_failed";
    }
    if (step === "run_task" || step === "queued" || step === "policy_approved") {
        return "execution_started";
    }
    return "phase_transition";
}

export async function persistExecutionUpdatePayload(
    payload: TaskExecutionUpdatedPayload
): Promise<ITaskExecutionEvent | null> {
    if (!payload.runId) {
        return null;
    }

    const phase = (payload.phase ?? "reason") as TaskExecutionEventPhase;
    const type = mapPayloadStateToEventType(payload.state, payload.step);

    return appendExecutionEvent({
        taskId: payload.taskId,
        conversationId: payload.conversationId,
        runId: payload.runId,
        type,
        phase,
        payload: {
            state: payload.state,
            step: payload.step ?? null,
            summary: payload.summary,
            error: payload.error ?? null,
            progress: payload.progress ?? null,
            actionType: payload.actionType,
            attempt: payload.attempt ?? null,
            toolName: payload.details?.toolName ?? null,
        },
    });
}
