import { NextResponse } from "next/server";
import { connectToDatabase } from "@/lib/Db/db";
import Message, { IMessagePopulated } from "@/models/Message";
import { normalizeMessage } from "@/server/normalizers/message.normalizer";
import mongoose from "mongoose";
import { getInternalSocketServerUrl } from "@/lib/socket/socketConfig";
import { createInternalRequestHeaders } from "@chat/types/utils/internal-bridge-auth";
import { requireAuthUser } from "@/lib/utils/auth/requireAuthUser";
import { requireConversationAccess } from "@/lib/utils/auth/requireConversationAccess";


export async function POST(
    req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const { id } = await params;
        const { emoji } = await req.json();

        // Auth check
        const guard = await requireAuthUser();
        if (guard.response) {
            return guard.response;
        }

        // Emoji validation
        if (!emoji || typeof emoji !== "string") {
            return NextResponse.json({ error: "Invalid emoji" }, { status: 400 });
        }

        await connectToDatabase();

        // Check if message exists and is not deleted
        const message = await Message.findById(id).select("isDeleted conversationId");
        if (!message) {
            return NextResponse.json({ error: "Message not found" }, { status: 404 });
        }
        if (message.isDeleted) {
            return NextResponse.json(
                { error: "Cannot react to deleted message" },
                { status: 400 }
            );
        }

        const access = await requireConversationAccess(
            message.conversationId.toString(),
            guard.user
        );
        if (access.response) return access.response;

        const userId = new mongoose.Types.ObjectId(guard.user.id);


        // Step 1: Remove user from all emoji arrays
        const messageDoc = await Message.findById(id).select("reactions");

        let alreadyReactedWithSameEmoji = false;

        if (messageDoc?.reactions instanceof Map) {
            const users = messageDoc.reactions.get(emoji) || [];

            alreadyReactedWithSameEmoji = users.some(
                (uid: mongoose.Types.ObjectId) =>
                    uid.toString() === userId.toString()
            );
        }

        /* Remove user from all emojis */
        const pullUpdate: Record<string, mongoose.Types.ObjectId> = {};

        if (messageDoc?.reactions instanceof Map) {
            for (const key of messageDoc.reactions.keys()) {
                pullUpdate[`reactions.${key}`] = userId;
            }
        }

        await Message.updateOne({ _id: id }, { $pull: pullUpdate });

        /* If same emoji → toggle off */
        if (!alreadyReactedWithSameEmoji) {
            await Message.updateOne(
                { _id: id },
                { $addToSet: { [`reactions.${emoji}`]: userId } }
            );
        }
        // Populate sender for normalization and return updated reactions
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

        // Emit socket event
        const response = await fetch(`${getInternalSocketServerUrl()}/internal/message-reaction`, {
            method: "POST",
            headers: createInternalRequestHeaders(),
            body: JSON.stringify({
                conversationId: populated.conversationId.toString(),
                payload: normalized,
            }),
        });

        if (!response.ok) {
            throw new Error("Failed to broadcast reaction update");
        }

        return NextResponse.json({ success: true, reactions: populated.reactions });
    } catch (error) {
        console.error("Reaction error:", error);
        return NextResponse.json(
            { error: "Internal Server Error" },
            { status: 500 }
        );
    }
}