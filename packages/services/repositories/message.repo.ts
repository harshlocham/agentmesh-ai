import Message, { IMessagePopulated } from "@chat/db/models/Message";
import { Types } from "mongoose";
import { IMessage } from "@chat/db/models/Message";
import { connectToDatabase } from "@chat/db";

export async function getPaginatedMessages(conversationId: string, cursor?: string, limit = 20) {
    const query: { conversationId: Types.ObjectId; _id?: { $lt: Types.ObjectId } } = { conversationId: new Types.ObjectId(conversationId) };
    if (cursor) {
        query._id = { $lt: new Types.ObjectId(cursor) };
    }
    await connectToDatabase();

    const messages = await Message.find(query)
        .sort({ _id: -1 })
        .limit(limit)
        .populate("sender", "username email profilePicture status _id")
        .populate("reactions.users", "username email profilePicture status _id")
        .populate({
            path: "repliedTo",
            select: "content sender messageType",
            populate: { path: "sender", select: "username profilePicture _id" },
        })
        .lean<IMessagePopulated[]>();

    return messages;
}
export async function saveMessage(data: Partial<IMessage>) {
    await connectToDatabase();
    const message = new Message(data);
    await message.save();
    return message;
}