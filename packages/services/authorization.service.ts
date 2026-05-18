import { Types } from "mongoose";
import { connectToDatabase } from "@chat/db";
import { Conversation } from "@chat/db/models/Conversation";
import TaskModel from "@chat/db/models/Task";

export type AuthorizationRole = "user" | "moderator" | "admin";

export type ConversationAccessOptions = {
    allowAdminBypass?: boolean;
    userRole?: AuthorizationRole;
};

export class AuthorizationError extends Error {
    readonly code: "FORBIDDEN" | "NOT_FOUND";

    constructor(code: "FORBIDDEN" | "NOT_FOUND", message: string) {
        super(message);
        this.name = "AuthorizationError";
        this.code = code;
    }
}

type ConversationAccessRecord = {
    _id: Types.ObjectId;
    participants: Types.ObjectId[];
};

function isValidObjectId(value: string): boolean {
    return Types.ObjectId.isValid(value);
}

function participantIdsFromConversation(conversation: ConversationAccessRecord): string[] {
    return conversation.participants.map((participant) => participant.toString());
}

function isParticipant(conversation: ConversationAccessRecord, userId: string): boolean {
    return conversation.participants.some((participant) => participant.toString() === userId);
}

function canAdminBypass(
    options: ConversationAccessOptions | undefined,
    conversation: ConversationAccessRecord | null,
    userId: string
): conversation is ConversationAccessRecord {
    if (!conversation) {
        return false;
    }

    if (options?.allowAdminBypass === false) {
        return false;
    }

    if (options?.userRole !== "admin") {
        return false;
    }

    return !isParticipant(conversation, userId);
}

async function loadConversationForAccess(
    conversationId: string
): Promise<ConversationAccessRecord | null> {
    if (!isValidObjectId(conversationId)) {
        return null;
    }

    await connectToDatabase();

    return Conversation.findById(conversationId)
        .select("_id participants")
        .lean<ConversationAccessRecord>();
}

export async function canAccessConversation(
    userId: string,
    conversationId: string,
    options?: ConversationAccessOptions
): Promise<boolean> {
    if (!isValidObjectId(userId)) {
        return false;
    }

    const conversation = await loadConversationForAccess(conversationId);
    if (!conversation) {
        return false;
    }

    if (isParticipant(conversation, userId)) {
        return true;
    }

    return canAdminBypass(options, conversation, userId);
}

export async function getAuthorizedConversation(
    userId: string,
    conversationId: string,
    options?: ConversationAccessOptions
): Promise<ConversationAccessRecord> {
    const access = await assertConversationAccess(userId, conversationId, options);
    const conversation = await loadConversationForAccess(access.conversationId);

    if (!conversation) {
        throw new AuthorizationError("FORBIDDEN", "Forbidden");
    }

    return conversation;
}

export async function assertConversationAccess(
    userId: string,
    conversationId: string,
    options?: ConversationAccessOptions
): Promise<{ conversationId: string; participantIds: string[] }> {
    if (!isValidObjectId(userId) || !isValidObjectId(conversationId)) {
        throw new AuthorizationError("FORBIDDEN", "Forbidden");
    }

    const conversation = await loadConversationForAccess(conversationId);
    if (!conversation) {
        throw new AuthorizationError("FORBIDDEN", "Forbidden");
    }

    if (isParticipant(conversation, userId) || canAdminBypass(options, conversation, userId)) {
        return {
            conversationId,
            participantIds: participantIdsFromConversation(conversation),
        };
    }

    throw new AuthorizationError("FORBIDDEN", "Forbidden");
}

export async function getConversationParticipantIds(conversationId: string): Promise<string[]> {
    const conversation = await loadConversationForAccess(conversationId);
    if (!conversation) {
        return [];
    }

    return participantIdsFromConversation(conversation);
}

export async function assertTaskAccess(
    userId: string,
    taskId: string,
    options?: ConversationAccessOptions
): Promise<{ taskId: string; conversationId: string }> {
    if (!isValidObjectId(userId) || !isValidObjectId(taskId)) {
        throw new AuthorizationError("FORBIDDEN", "Forbidden");
    }

    await connectToDatabase();

    const task = await TaskModel.findById(taskId).select("conversationId").lean<{
        _id: Types.ObjectId;
        conversationId: Types.ObjectId;
    }>();

    if (!task) {
        throw new AuthorizationError("NOT_FOUND", "Task not found");
    }

    const conversationId = task.conversationId.toString();
    await assertConversationAccess(userId, conversationId, options);

    return {
        taskId,
        conversationId,
    };
}

export async function assertMessageConversationAccess(
    userId: string,
    conversationId: string,
    options?: ConversationAccessOptions
): Promise<void> {
    await assertConversationAccess(userId, conversationId, options);
}

export async function assertMessageInAccessibleConversation(
    userId: string,
    messageConversationId: string,
    options?: ConversationAccessOptions
): Promise<string> {
    await assertConversationAccess(userId, messageConversationId, options);
    return messageConversationId;
}
