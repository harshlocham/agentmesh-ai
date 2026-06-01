import { NextRequest, NextResponse } from "next/server";
import { connectToDatabase } from "@/lib/Db/db";
import { requireAuthUser } from "@/lib/utils/auth/requireAuthUser";
import { requireTaskAccess } from "@/lib/utils/auth/requireConversationAccess";
import { getExecutionEventsAfter } from "@chat/services/execution-event.service";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    try {
        const { id } = await params;
        const guard = await requireAuthUser();
        if (guard.response) return guard.response;

        await connectToDatabase();

        const access = await requireTaskAccess(id, guard.user);
        if (access.response) return access.response;

        const url = new URL(req.url);
        const afterSequence = Number(url.searchParams.get("afterSequence") ?? "0");
        const limit = Number(url.searchParams.get("limit") ?? "200");
        const runId = url.searchParams.get("runId") ?? undefined;

        const events = await getExecutionEventsAfter({
            taskId: id,
            afterSequence: Number.isFinite(afterSequence) ? afterSequence : 0,
            limit: Number.isFinite(limit) ? limit : 200,
            runId,
        });

        const normalized = events.map((event) => ({
            _id: event._id.toString(),
            taskId: event.taskId.toString(),
            conversationId: event.conversationId.toString(),
            runId: event.runId,
            sequence: event.sequence,
            type: event.type,
            phase: event.phase,
            payload: event.payload,
            createdAt: event.createdAt.toISOString(),
        }));

        const nextCursor = normalized.length > 0
            ? normalized[normalized.length - 1].sequence
            : afterSequence;

        return NextResponse.json({ events: normalized, nextCursor }, { status: 200 });
    } catch (error) {
        console.error("GET /api/tasks/:id/execution-events error", error);
        return NextResponse.json({ error: "Failed to fetch execution events" }, { status: 500 });
    }
}
