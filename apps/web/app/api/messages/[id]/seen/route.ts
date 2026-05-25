import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import Message from "@/models/Message";
import { requireAuthUser } from "@/lib/utils/auth/requireAuthUser";
import { requireConversationAccess } from "@/lib/utils/auth/requireConversationAccess";
import { markMessagesSeen } from "@/lib/services/message-receipt.service";
import { getInternalSocketServerUrl } from "@/lib/socket/socketConfig";
import { createInternalRequestHeaders } from "@chat/types/utils/internal-bridge-auth";

export async function PATCH(
    request: NextRequest,
    context: { params: Promise<{ id: string }> }
) {
    try {
        const { id: messageId } = await context.params;
        const body = (await request.json().catch(() => ({}))) as {
            conversationId?: string;
            messageIds?: string[];
        };

        const guard = await requireAuthUser();
        if (guard.response) {
            return guard.response;
        }

        if (!mongoose.Types.ObjectId.isValid(messageId)) {
            return NextResponse.json({ error: "Invalid message ID" }, { status: 400 });
        }

        const inputMessageIds = Array.isArray(body.messageIds) && body.messageIds.length > 0
            ? body.messageIds
            : [messageId];

        const validMessageIds = inputMessageIds.filter((id) => mongoose.Types.ObjectId.isValid(id));
        if (validMessageIds.length === 0) {
            return NextResponse.json({ error: "No valid message IDs" }, { status: 400 });
        }

        let conversationId = body.conversationId;
        if (!conversationId) {
            const firstMessage = await Message.findById(validMessageIds[0])
                .select("conversationId")
                .lean<{ conversationId: { toString(): string } }>();
            if (!firstMessage) {
                return NextResponse.json({ error: "Message not found" }, { status: 404 });
            }
            conversationId = firstMessage.conversationId.toString();
        }

        if (!mongoose.Types.ObjectId.isValid(conversationId)) {
            return NextResponse.json({ error: "Invalid conversation ID" }, { status: 400 });
        }

        const access = await requireConversationAccess(conversationId, guard.user);
        if (access.response) return access.response;

        const seenAt = new Date();

        const updatedIds = await markMessagesSeen({
            conversationId,
            messageIds: validMessageIds,
            userId: guard.user.id,
            at: seenAt,
        });

        if (updatedIds.length === 0) {
            return NextResponse.json({ ok: true, updated: [] });
        }

        const response = await fetch(`${getInternalSocketServerUrl()}/internal/message-seen`, {
            method: "POST",
            headers: createInternalRequestHeaders(),
            body: JSON.stringify({
                conversationId,
                messageIds: updatedIds,
                userId: guard.user.id,
                seenAt,
            }),
        });

        if (!response.ok) {
            throw new Error("Failed to broadcast seen update");
        }

        return NextResponse.json({ ok: true, updated: updatedIds });
    } catch (error) {
        console.error("PATCH /api/messages/:id/seen error", error);
        return NextResponse.json({ error: "Server error" }, { status: 500 });
    }
}