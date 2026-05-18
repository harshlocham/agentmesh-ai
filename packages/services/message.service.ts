'use server';
import { CreateMessageInput } from "@/lib/validators/message.schema";
import mongoose, { Types } from "mongoose";
import { Conversation } from "@chat/db/models/Conversation";
import Message, { IMessagePopulated } from "@chat/db/models/Message";
import { assertConversationAccess } from "./authorization.service";
import { enqueueOutboxEvent } from "./outbox.service";
//import { socket } from "@/lib/socket/socketClient";

export async function createMessage(data: CreateMessageInput, senderId: string) {
    await assertConversationAccess(senderId, data.conversationId);

    const conversationId = new Types.ObjectId(data.conversationId);
    const senderObjectId = new Types.ObjectId(senderId);

    let savedMessageId: Types.ObjectId | null = null;

    const createWithOutboxNoTxn = async () => {
        const conversation = await Conversation.findById(conversationId);
        if (!conversation) {
            throw new Error("Conversation not found");
        }

        const saved = await Message.create({
            sender: senderObjectId,
            conversationId,
            content: data.content,
            messageType: data.messageType ?? "text",
            status: "sent",
            delivered: false,
            seen: false,
            ...(data.replyTo ? { repliedTo: new Types.ObjectId(data.replyTo) } : {}),
        });

        savedMessageId = saved._id;

        conversation.lastMessage = {
            _id: saved._id,
            sender: saved.sender,
            messageType: saved.messageType,
            content: saved.content,
            _creationTime: saved.createdAt ?? new Date(),
        };
        await conversation.save();

        await enqueueOutboxEvent({
            topic: "message.created",
            dedupeKey: `message.created:${saved._id.toString()}`,
            payload: {
                messageId: saved._id.toString(),
                conversationId: conversationId.toString(),
                senderId,
                content: saved.content,
                messageType: saved.messageType,
            },
        });
    };

    const session = await mongoose.startSession();

    try {
        await session.withTransaction(async () => {
            const conversation = await Conversation.findById(conversationId).session(session);
            if (!conversation) {
                throw new Error("Conversation not found");
            }

            const created = await Message.create(
                [
                    {
                        sender: senderObjectId,
                        conversationId,
                        content: data.content,
                        messageType: data.messageType ?? "text",
                        status: "sent",
                        delivered: false,
                        seen: false,
                        ...(data.replyTo ? { repliedTo: new Types.ObjectId(data.replyTo) } : {}),
                    },
                ],
                { session }
            );

            const saved = created[0];
            savedMessageId = saved._id;

            conversation.lastMessage = {
                _id: saved._id,
                sender: saved.sender,
                messageType: saved.messageType,
                content: saved.content,
                _creationTime: saved.createdAt ?? new Date(),
            };
            await conversation.save({ session });

            await enqueueOutboxEvent({
                topic: "message.created",
                dedupeKey: `message.created:${saved._id.toString()}`,
                payload: {
                    messageId: saved._id.toString(),
                    conversationId: conversationId.toString(),
                    senderId,
                    content: saved.content,
                    messageType: saved.messageType,
                },
                session,
            });
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const transactionUnsupported =
            message.includes("Transaction numbers are only allowed")
            || message.includes("replica set")
            || message.includes("standalone");

        if (!transactionUnsupported) {
            throw error;
        }

        await createWithOutboxNoTxn();
    } finally {
        await session.endSession();
    }

    if (!savedMessageId) {
        throw new Error("Failed to save message");
    }

    // Populate sender and repliedTo so normalizeMessage can serialize them safely.
    const populated = await Message.findById(savedMessageId)
        .populate("sender", "username profilePicture _id")
        .populate({
            path: "repliedTo",
            select: "content sender messageType",
            populate: { path: "sender", select: "username profilePicture _id" },
        })
        .lean<IMessagePopulated>();

    if (!populated) throw new Error("Failed to retrieve saved message");
    return populated;
}

export async function updateMessageReaction({ messageId, emoji, userId }: { messageId: string; emoji: string; userId: string }) {
    const msg = await Message.findById(messageId).select("reactions");
    if (!msg) return null;

    const userObjectId = new Types.ObjectId(userId);
    let alreadyReactedWithSameEmoji = false;

    if (msg.reactions instanceof Map) {
        const users = msg.reactions.get(emoji) || [];
        alreadyReactedWithSameEmoji = users.some(
            (uid: Types.ObjectId) => uid.toString() === userObjectId.toString()
        );
    }

    const pullUpdate: Record<string, Types.ObjectId> = {};
    if (msg.reactions instanceof Map) {
        for (const key of msg.reactions.keys()) {
            pullUpdate[`reactions.${key}`] = userObjectId;
        }
    }

    if (Object.keys(pullUpdate).length > 0) {
        await Message.updateOne({ _id: messageId }, { $pull: pullUpdate });
    }

    if (!alreadyReactedWithSameEmoji) {
        await Message.updateOne(
            { _id: messageId },
            { $addToSet: { [`reactions.${emoji}`]: userObjectId } }
        );
    }

    const updated = await Message.findById(messageId)
        .populate([
            { path: "sender", select: "username avatarUrl" },
            { path: "repliedTo", populate: { path: "sender" } },
        ])
        .lean();
    return updated;
}
export async function editMessageById(messageId: string, text: string) {
    const msg = await Message.findById(messageId);
    if (!msg) return null;

    msg.content = text;
    msg.isEdited = true;
    await msg.save();

    // Populate 
    const updated = await Message.findById(messageId)
        .populate([
            { path: "sender", select: "username avatarUrl" },
            { path: "repliedTo", populate: { path: "sender" } },
        ])
        .lean();

    return updated;
}
