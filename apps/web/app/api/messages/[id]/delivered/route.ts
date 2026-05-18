import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import Message from "@/models/Message";
import { requireAuthUser } from "@/lib/utils/auth/requireAuthUser";
import { requireConversationAccess } from "@/lib/utils/auth/requireConversationAccess";
import { markMessageDelivered } from "@/lib/services/message-receipt.service";
import { getInternalSocketServerUrl } from "@/lib/socket/socketConfig";
import { createInternalRequestHeaders } from "@chat/types/utils/internal-bridge-auth";

export async function PATCH(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const guard = await requireAuthUser();
        if (guard.response) {
            return guard.response;
        }

        const { id } = await params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return NextResponse.json({ error: "Invalid message ID" }, { status: 400 });
        }

        const { at } = (await req.json().catch(() => ({}))) as { at?: string | Date };

        const message = await Message.findById(id).select("sender conversationId");
        if (!message) {
            return NextResponse.json({ error: "Message not found" }, { status: 404 });
        }

        const userId = guard.user.id;

        const access = await requireConversationAccess(
            message.conversationId.toString(),
            guard.user
        );
        if (access.response) return access.response;

        // ❌ sender should NOT mark delivered
        if (message.sender.toString() === userId) {
            return NextResponse.json(
                { error: "Sender cannot mark delivered" },
                { status: 403 }
            );
        }

        const deliveredAt = at ? new Date(at) : new Date();
        await markMessageDelivered({ messageId: id, userId, at: deliveredAt });

        const response = await fetch(`${getInternalSocketServerUrl()}/internal/message-delivered`, {
            method: "POST",
            headers: createInternalRequestHeaders(),
            body: JSON.stringify({
                messageId: id,
                conversationId: message.conversationId.toString(),
                userId,
                deliveredAt,
                senderId: message.sender.toString(),
            }),
        });

        if (!response.ok) {
            throw new Error("Failed to broadcast delivery update");
        }

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error("PATCH /api/messages/:id/delivered error", error);
        return NextResponse.json({ error: "Server error" }, { status: 500 });
    }
}