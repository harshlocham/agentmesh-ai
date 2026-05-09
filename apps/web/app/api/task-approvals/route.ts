import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { enqueueOutboxEvent } from "@/lib/services/outbox.service";
import { getPendingApprovalTaskActions, getTaskActionById, updateTaskActionExecutionState } from "@/lib/services/repositories/task.repo";
import { requireAdminUser } from "@/lib/utils/auth/requireAdminUser";

const decisionSchema = z.object({
    taskActionId: z.string().min(1),
    decision: z.enum(["approve", "reject"]),
    reason: z.string().max(2000).optional(),
    reviewerComment: z.string().max(2000).optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
});

function serializeTaskAction(action: Awaited<ReturnType<typeof getPendingApprovalTaskActions>>[number]) {
    return {
        _id: action._id.toString(),
        taskId: action.taskId.toString(),
        conversationId: action.conversationId.toString(),
        actorType: action.actorType,
        actorId: action.actorId ? action.actorId.toString() : null,
        actionType: action.actionType,
        toolName: action.toolName ?? null,
        messageId: action.messageId ? action.messageId.toString() : null,
        parameters: action.parameters ?? {},
        executionState: action.executionState ?? null,
        summary: action.summary ?? null,
        error: action.error ?? null,
        patch: action.patch,
        reason: action.reason,
        idempotencyKey: action.idempotencyKey,
        createdAt: action.createdAt.toISOString(),
    };
}

function asRecord(value: unknown): Record<string, unknown> {
    if (value && typeof value === "object" && !Array.isArray(value)) {
        return value as Record<string, unknown>;
    }

    return {};
}

export async function GET(req: NextRequest) {
    const guard = await requireAdminUser();
    if (guard.response) return guard.response;

    const { searchParams } = new URL(req.url);
    const conversationId = searchParams.get("conversationId") ?? undefined;

    const actions = await getPendingApprovalTaskActions(conversationId);
    return NextResponse.json({ approvals: actions.map(serializeTaskAction) }, { status: 200 });
}

export async function POST(req: NextRequest) {
    const guard = await requireAdminUser();
    if (guard.response) return guard.response;

    const parse = decisionSchema.safeParse(await req.json());
    if (!parse.success) {
        return NextResponse.json({ error: "Invalid approval decision payload" }, { status: 400 });
    }

    const body = parse.data;
    const action = await getTaskActionById(body.taskActionId);

    if (!action) {
        return NextResponse.json({ error: "Approval request not found" }, { status: 404 });
    }

    if (action.executionState !== "approval_pending") {
        return NextResponse.json({ error: `Approval request is not pending (state=${action.executionState ?? "null"})` }, { status: 409 });
    }

    if (body.decision === "reject") {
        const rejectNote = body.reason ?? body.reviewerComment ?? "Rejected by reviewer.";
        const updated = await updateTaskActionExecutionState({
            taskActionId: body.taskActionId,
            executionState: "rejected",
            summary: action.summary ?? null,
            error: rejectNote,
            reason: `${action.reason}${rejectNote ? ` | reviewer: ${rejectNote}` : ""}`,
        });

        return NextResponse.json({ approval: updated ? serializeTaskAction(updated) : null }, { status: 200 });
    }

    const approvedParameters = body.parameters ?? action.parameters ?? {};
    const reviewerComment = body.reviewerComment ?? body.reason ?? "Approved by reviewer.";

    const updated = await updateTaskActionExecutionState({
        taskActionId: body.taskActionId,
        executionState: "approved",
        summary: action.summary ?? null,
        error: null,
        parameters: approvedParameters,
        reason: `${action.reason}${reviewerComment ? ` | reviewer: ${reviewerComment}` : ""}`,
        patch: {
            before: action.patch?.before ?? null,
            after: {
                ...asRecord(action.patch?.after),
                approvedParameters,
                reviewerComment,
                approvedAt: new Date().toISOString(),
            },
        },
    });

    await enqueueOutboxEvent({
        topic: "task.execution.approved",
        dedupeKey: `task.execution.approved:${body.taskActionId}`,
        payload: {
            taskId: action.taskId.toString(),
            conversationId: action.conversationId.toString(),
            taskActionId: body.taskActionId,
            approvedByType: guard.user.role === "admin" ? "system" : "user",
            approvedById: guard.user.id,
            reason: reviewerComment,
        },
    });

    return NextResponse.json({ approval: updated ? serializeTaskAction(updated) : null }, { status: 200 });
}