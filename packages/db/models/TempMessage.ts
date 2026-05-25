import mongoose from "mongoose";
import { IUser } from "@chat/db/models/User";

export interface ITempMessage {
    _id: string;
    conversationId: string;
    senderId: string;
    isDeleted: boolean;
    repliedTo?: mongoose.Types.ObjectId;
    reactions?: {
        emoji: string;
        users: mongoose.Types.ObjectId[]; // who reacted
    }[];
    content: string;
    messageType: "text" | "image";
    status: "pending" | "queued";
    sender: IUser;
    createdAt: Date;
}