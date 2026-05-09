import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { connectToDatabase } from "@/lib/Db/db";
import { requireAuthUser } from "@/lib/utils/auth/requireAuthUser";
import { updateTask } from "@/lib/repositories/task.repo";
import TaskModel from "@/models/Task";
import { normalizeTask } from "@/server/normalizers/task.normalizer";
import { enqueueOutboxEvent } from "@/lib/services/outbox.service";

const updateTaskBodySchema = z.object({
    title: z.string().min(3).max(200).optional(),
    description: z.string().max(8000).optional(),
    status: z.enum(["pending", "executing", "completed", "failed", "partial"]).optional(),
    priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
    assignees: z.array(z.string().min(1)).max(32).optional(),
    dueAt: z.coerce.date().nullable().optional(),
    tags: z.array(z.string().min(1).max(48)).optional(),
});

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    try {
        const { id } = await params;
        const guard = await requireAuthUser();
        if (guard.response) return guard.response;

        await connectToDatabase();

        const body = updateTaskBodySchema.parse(await req.json());
        const before = await TaskModel.findById(id).lean();
        if (!before) {
            return NextResponse.json({ error: "Task not found" }, { status: 404 });
        }

        const updated = await updateTask({
            taskId: id,
            ...body,
            updatedBy: guard.user.id,
        });

        if (!updated) {
            return NextResponse.json({ error: "Task not found" }, { status: 404 });
        }

        const normalized = normalizeTask(updated);

        await enqueueOutboxEvent({
            topic: "task.updated",
            dedupeKey: `task.updated:${normalized._id}:${normalized.updatedAt}`,
            payload: {
                conversationId: normalized.conversationId,
                socketPath: "/internal/task-updated",
                socketPayload: {
                    taskId: normalized._id,
                    conversationId: normalized.conversationId,
                    patch: body,
                    previousVersion: before.version ?? 0,
                    newVersion: normalized.version,
                    updatedByType: "user",
                    updatedById: guard.user.id,
                },
            },
        });

        return NextResponse.json(normalized, { status: 200 });
    } catch (error) {
        console.error("PATCH /api/tasks/:id error", error);
        return NextResponse.json({ error: "Invalid task update payload" }, { status: 400 });
    }
}