import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import TaskModel from "@/models/Task";
import { connectToDatabase } from "@/lib/Db/db";
import { requireAuthUser } from "@/lib/utils/auth/requireAuthUser";
import { requireConversationAccess } from "@/lib/utils/auth/requireConversationAccess";
import { buildTaskActionIdempotencyKey, createTask, createTaskAction } from "@/lib/repositories/task.repo";
import { normalizeTask } from "@/server/normalizers/task.normalizer";
import { deriveTaskDedupeKey } from "@/lib/services/task.service";
import { enqueueOutboxEvent } from "@/lib/services/outbox.service";

const createTaskBodySchema = z.object({
    conversationId: z.string().min(1),
    title: z.string().min(3).max(200),
    description: z.string().max(8000).optional(),
    assignees: z.array(z.string().min(1)).max(32).optional(),
    dueAt: z.coerce.date().nullable().optional(),
    priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
    sourceMessageIds: z.array(z.string().min(1)).optional(),
    tags: z.array(z.string().min(1).max(48)).optional(),
});

export async function GET(req: NextRequest) {
    const guard = await requireAuthUser();
    if (guard.response) return guard.response;

    await connectToDatabase();

    const { searchParams } = new URL(req.url);
    const conversationId = searchParams.get("conversationId");
    if (!conversationId) {
        return NextResponse.json({ error: "conversationId is required" }, { status: 400 });
    }

    const access = await requireConversationAccess(conversationId, guard.user);
    if (access.response) return access.response;

    const tasks = await TaskModel.find({ conversationId }).sort({ updatedAt: -1 }).limit(200).lean();
    return NextResponse.json(tasks.map(normalizeTask), { status: 200 });
}

export async function POST(req: NextRequest) {
    try {
        const guard = await requireAuthUser();
        if (guard.response) return guard.response;

        await connectToDatabase();

        const body = createTaskBodySchema.parse(await req.json());

        const access = await requireConversationAccess(body.conversationId, guard.user);
        if (access.response) return access.response;

        const dedupeKey = deriveTaskDedupeKey({
            conversationId: body.conversationId,
            title: body.title,
            sourceMessageId: body.sourceMessageIds?.[0] ?? null,
        });

        const task = await createTask({
            conversationId: body.conversationId,
            parentTaskId: null,
            title: body.title,
            description: body.description ?? "",
            assignees: body.assignees ?? [],
            dueAt: body.dueAt ?? null,
            priority: body.priority ?? "medium",
            source: "manual",
            sourceMessageIds: body.sourceMessageIds ?? [],
            latestContextMessageId: body.sourceMessageIds?.[0] ?? null,
            confidence: 1,
            tags: body.tags ?? [],
            dedupeKey,
            createdBy: guard.user.id,
            subTasks: [],
            dependencyIds: [],
            lifecycleState: "ready",
            iterationCount: 0,
            currentRunId: null,
            currentStepId: null,
            leaseOwner: null,
            leaseExpiresAt: null,
            lastHeartbeatAt: null,
            nextRetryAt: null,
            blockedReason: null,
            pausedReason: null,
            progress: 0,
            checkpoints: [],
            executionHistory: {
                attempts: 0,
                failures: 0,
                results: [],
            },
        });

        const normalized = normalizeTask(task);

        const manualActionParams = {
            titleHint: normalized.title,
            descriptionHint: normalized.description ?? "",
            content: [normalized.title, normalized.description].filter((part) => typeof part === "string" && part.trim().length > 0).join("\n\n"),
        };

        try {
            await createTaskAction({
                taskId: normalized._id,
                conversationId: normalized.conversationId,
                actorType: "user",
                actorId: guard.user.id,
                actionType: "none",
                toolName: "none",
                messageId: null,
                parameters: manualActionParams,
                executionState: "requested",
                summary: "Manual task execution requested from task panel.",
                error: null,
                patch: {
                    before: null,
                    after: {
                        actionType: "none",
                        toolName: "none",
                        source: "manual-task-panel",
                    },
                },
                reason: "User-created task delegated to autonomous agent runner",
                idempotencyKey: buildTaskActionIdempotencyKey(normalized._id, "requested:none", `manual-${guard.user.id}`),
            });
        } catch (error) {
            const maybeMongoError = error as { code?: number };
            if (maybeMongoError?.code !== 11000) {
                throw error;
            }
        }

        await enqueueOutboxEvent({
            topic: "task.created",
            dedupeKey: `task.created:${normalized._id}`,
            payload: {
                conversationId: normalized.conversationId,
                socketPath: "/internal/task-created",
                socketPayload: {
                    task: normalized,
                    sourceMessageId: normalized.sourceMessageIds[0] ?? null,
                    createdByType: "user",
                },
            },
        });

        await enqueueOutboxEvent({
            topic: "task.execution.requested",
            dedupeKey: `task.execution.requested:${normalized._id}:manual-create:none`,
            payload: {
                taskId: normalized._id,
                conversationId: normalized.conversationId,
                triggerMessageId: normalized._id,
                requestedByType: "user",
                requestedById: guard.user.id,
                actionType: "none",
                parameters: manualActionParams,
                confidence: 1,
                needsApproval: false,
            },
        });

        return NextResponse.json(normalized, { status: 201 });
    } catch (error) {
        console.error("POST /api/tasks error", error);
        return NextResponse.json({ error: "Invalid task payload" }, { status: 400 });
    }
}