import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import TaskModel from "@/models/Task";
import { connectToDatabase } from "@/lib/Db/db";
import { requireAuthUser } from "@/lib/utils/auth/requireAuthUser";
import { createTask } from "@/lib/repositories/task.repo";
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

    const tasks = await TaskModel.find({ conversationId }).sort({ updatedAt: -1 }).limit(200).lean();
    return NextResponse.json(tasks.map(normalizeTask), { status: 200 });
}

export async function POST(req: NextRequest) {
    try {
        const guard = await requireAuthUser();
        if (guard.response) return guard.response;

        await connectToDatabase();

        const body = createTaskBodySchema.parse(await req.json());
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

        return NextResponse.json(normalized, { status: 201 });
    } catch (error) {
        console.error("POST /api/tasks error", error);
        return NextResponse.json({ error: "Invalid task payload" }, { status: 400 });
    }
}