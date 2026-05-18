import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { connectToDatabase } from "@/lib/Db/db";
import Message from "@/models/Message";
import { requireAuthUser } from "@/lib/utils/auth/requireAuthUser";
import { requireConversationAccess } from "@/lib/utils/auth/requireConversationAccess";
import { updateMessageSemanticState } from "@/lib/repositories/task.repo";
import { getInternalSocketServerUrl } from "@/lib/socket/socketConfig";
import { createInternalRequestHeaders } from "@chat/types/utils/internal-bridge-auth";

const semanticOverrideSchema = z.object({
    semanticType: z.enum(["chat", "task", "decision", "reminder", "unknown"]),
    linkedTaskIds: z.array(z.string().min(1)).optional().default([]),
    confidence: z.number().min(0).max(1).optional().default(1),
});

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    try {
        const { id } = await params;
        const guard = await requireAuthUser();
        if (guard.response) return guard.response;

        await connectToDatabase();

        const body = semanticOverrideSchema.parse(await req.json());
        const message = await Message.findById(id).select("conversationId").lean();

        if (!message) {
            return NextResponse.json({ error: "Message not found" }, { status: 404 });
        }

        const access = await requireConversationAccess(
            message.conversationId.toString(),
            guard.user
        );
        if (access.response) return access.response;

        const now = new Date();
        await updateMessageSemanticState(id, {
            semanticType: body.semanticType,
            semanticConfidence: body.confidence,
            aiStatus: "overridden",
            aiVersion: "manual-override-v1",
            manualOverride: true,
            overrideBy: guard.user.id,
            overrideAt: now,
            semanticProcessedAt: now,
            linkedTaskIds: body.linkedTaskIds,
        });

        await fetch(`${getInternalSocketServerUrl()}/internal/message-semantic-updated`, {
            method: "POST",
            headers: createInternalRequestHeaders(),
            body: JSON.stringify({
                conversationId: message.conversationId.toString(),
                payload: {
                    messageId: id,
                    conversationId: message.conversationId.toString(),
                    semanticType: body.semanticType,
                    semanticConfidence: body.confidence,
                    aiStatus: "overridden",
                    aiVersion: "manual-override-v1",
                    linkedTaskIds: body.linkedTaskIds,
                    semanticProcessedAt: now.toISOString(),
                },
            }),
        });

        return NextResponse.json({ success: true }, { status: 200 });
    } catch (error) {
        console.error("PATCH /api/messages/:id/semantic error", error);
        return NextResponse.json({ error: "Invalid semantic payload" }, { status: 400 });
    }
}