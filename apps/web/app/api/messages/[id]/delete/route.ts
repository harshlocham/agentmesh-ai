import { NextResponse } from "next/server";
import { requireAuthUser } from "@/lib/utils/auth/requireAuthUser";
import { requireConversationAccess } from "@/lib/utils/auth/requireConversationAccess";
import { connectToDatabase } from "@/lib/Db/db";
import Message, { IMessagePopulated } from "@/models/Message";
import { normalizeMessage } from "@/server/normalizers/message.normalizer";
import { getInternalSocketServerUrl } from "@/lib/socket/socketConfig";
import { createInternalRequestHeaders } from "@chat/types/utils/internal-bridge-auth";

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const guard = await requireAuthUser();
    if (guard.response) return guard.response;

    await connectToDatabase();
    const message = await Message.findById(id);
    if (!message) return NextResponse.json({ error: "Message not found" }, { status: 404 });
    const access = await requireConversationAccess(
        message.conversationId.toString(),
        guard.user
    );
    if (access.response) return access.response;

    if (String(message.sender) !== guard.user.id) {
        return NextResponse.json({ error: "Not allowed" }, { status: 403 });
    }

    message.isDeleted = true;
    message.content = "This message was deleted";
    await message.save();

    const populated = await Message.findById(id)
        .populate("sender", "username profilePicture _id")
        .populate({
            path: "repliedTo",
            select: "content sender messageType",
            populate: { path: "sender", select: "username profilePicture _id" },
        })
        .lean<IMessagePopulated>();

    if (!populated) {
        return NextResponse.json({ error: "Message not found" }, { status: 404 });
    }

    const normalized = normalizeMessage(populated);
    const res = await fetch(`${getInternalSocketServerUrl()}/internal/message-deleted`, {
        method: "POST",
        headers: createInternalRequestHeaders(),
        body: JSON.stringify({
            conversationId: message.conversationId.toString(),
            payload: normalized,
        }),
    });
    if (!res.ok) throw new Error("Failed to broadcast message deletion");

    return NextResponse.json({ success: true });
}