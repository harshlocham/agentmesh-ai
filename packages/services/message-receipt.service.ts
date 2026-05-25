import mongoose, { Types } from "mongoose";
import Message from "@chat/db/models/Message";
import { connectToDatabase } from "@chat/db";

function toObjectId(id: string) {
    return new Types.ObjectId(id);
}

function isValidObjectId(id: string) {
    return mongoose.Types.ObjectId.isValid(id);
}

export async function markMessageDelivered(params: {
    messageId: string;
    userId: string;
    at?: Date;
}) {
    const { messageId, userId, at = new Date() } = params;
    if (!isValidObjectId(messageId) || !isValidObjectId(userId)) return false;

    await connectToDatabase();

    const result = await Message.updateOne(
        {
            _id: toObjectId(messageId),
            sender: { $ne: toObjectId(userId) },
            "deliveredTo.userId": { $ne: toObjectId(userId) },
        },
        {
            $push: { deliveredTo: { userId: toObjectId(userId), at } },
            $set: { delivered: true, status: "delivered" },
        }
    );

    return result.modifiedCount > 0;
}

export async function markMessagesSeen(params: {
    conversationId: string;
    messageIds: string[];
    userId: string;
    at?: Date;
}) {
    const { conversationId, messageIds, userId, at = new Date() } = params;

    if (!isValidObjectId(conversationId) || !isValidObjectId(userId)) {
        return [] as string[];
    }

    const validMessageIds = messageIds.filter(isValidObjectId);
    if (validMessageIds.length === 0) return [] as string[];

    await connectToDatabase();

    const userObjectId = toObjectId(userId);
    const messageObjectIds = validMessageIds.map(toObjectId);

    const targetMessages = await Message.find({
        _id: { $in: messageObjectIds },
        conversationId: toObjectId(conversationId),
        sender: { $ne: userObjectId },
    })
        .select("_id")
        .lean<Array<{ _id: { toString(): string } }>>();

    const targetIds = targetMessages.map((message) => message._id.toString());
    if (targetIds.length === 0) return [] as string[];

    const targetObjectIds = targetIds.map(toObjectId);

    await Message.updateMany(
        {
            _id: { $in: targetObjectIds },
            conversationId: toObjectId(conversationId),
            sender: { $ne: userObjectId },
            "seenBy.userId": { $ne: userObjectId },
        },
        {
            $push: { seenBy: { userId: userObjectId, at } },
            $set: { seen: true, status: "seen", delivered: true },
        }
    );

    await Message.updateMany(
        {
            _id: { $in: targetObjectIds },
            conversationId: toObjectId(conversationId),
            sender: { $ne: userObjectId },
            "deliveredTo.userId": { $ne: userObjectId },
        },
        {
            $push: { deliveredTo: { userId: userObjectId, at } },
            $set: { delivered: true },
        }
    );

    return targetIds;
}
