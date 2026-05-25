import type { ClientUser } from "../user/user";
import type { MessageTaskMetadata } from "../task/task";

export interface ClientReaction {
    emoji: string;
    users: ClientUser[];
}
export interface ClientMessage extends MessageTaskMetadata {
    _id: string;
    conversationId: string;

    content: string;
    messageType: "text" | "image" | "file" | "system" | "video" | "audio" | "voice";
    status: "pending" | "failed" | "sent" | "delivered" | "seen" | "queued";
    sender: Pick<ClientUser, "_id" | "username" | "profilePicture">;

    createdAt: string;
    updatedAt?: string;

    isDeleted?: boolean;
    isEdited?: boolean;
    editedAt?: string;
    reactions?: ClientReaction[];
    seenBy?: string[];
    deliveredTo?: string[];

    repliedTo?: {
        _id: string;
        content: string;
        sender: Pick<ClientUser, "_id" | "username" | "profilePicture">;
    } | null;
}