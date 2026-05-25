import type { MessageDTO } from "@chat/types";
import { IMessagePopulated } from "@chat/db/models/Message";

type Stringable = { toString(): string };
type ReactionUser = string | (Stringable & { _id?: string | Stringable });
type ReceiptEntry =
    | string
    | Stringable
    | {
        userId?: string | Stringable;
        user?: string | Stringable;
    };

function normalizeReceiptUsers(entries?: ReceiptEntry[]): string[] {
    if (!entries || !Array.isArray(entries)) return [];

    return entries
        .map((entry) => {
            if (!entry) return "";
            if (typeof entry === "string") return entry;

            if (typeof entry === "object" && "userId" in entry && entry.userId) {
                return typeof entry.userId === "string"
                    ? entry.userId
                    : entry.userId.toString();
            }

            if (typeof entry === "object" && "user" in entry && entry.user) {
                return typeof entry.user === "string"
                    ? entry.user
                    : entry.user.toString();
            }

            return entry.toString();
        })
        .filter(Boolean);
}

export function normalizeMessage(doc: IMessagePopulated): MessageDTO {
    return {
        _id: doc._id.toString(),
        conversationId: doc.conversationId.toString(),

        content: doc.content,
        messageType: doc.messageType,

        sender: {
            _id: doc.sender._id.toString(),
            username: doc.sender.username,
            profilePicture: doc.sender.profilePicture,
        },

        createdAt: new Date(doc.createdAt).toISOString(),
        updatedAt: doc.updatedAt
            ? new Date(doc.updatedAt).toISOString()
            : undefined,

        semanticType: doc.semanticType,
        semanticConfidence: doc.semanticConfidence,
        aiStatus: doc.aiStatus,
        aiVersion: doc.aiVersion ?? null,
        linkedTaskIds: doc.linkedTaskIds?.map((taskId) => taskId.toString()) ?? [],
        manualOverride: doc.manualOverride,
        overrideBy: doc.overrideBy ? doc.overrideBy.toString() : null,
        overrideAt: doc.overrideAt ? new Date(doc.overrideAt).toISOString() : null,
        semanticProcessedAt: doc.semanticProcessedAt
            ? new Date(doc.semanticProcessedAt).toISOString()
            : null,

        isDeleted: doc.isDeleted,
        isEdited: doc.isEdited,
        delivered: Boolean(doc.delivered),
        seen: Boolean(doc.seen),
        editedAt: doc.isEdited && doc.updatedAt
            ? new Date(doc.updatedAt).toISOString()
            : undefined,

        reactions: doc.reactions
            ? normalizeReactions(
                doc.reactions instanceof Map
                    ? Object.fromEntries(doc.reactions)
                    : doc.reactions
            )
            : [],

        seenBy: normalizeReceiptUsers(doc.seenBy as unknown as ReceiptEntry[]),
        deliveredTo: normalizeReceiptUsers(doc.deliveredTo as unknown as ReceiptEntry[]),
        repliedTo: doc.repliedTo ? {
            _id: doc.repliedTo._id.toString(),
            content: doc.repliedTo.content,
            sender: {
                _id: doc.repliedTo.sender._id.toString(),
                username: doc.repliedTo.sender.username,
                profilePicture: doc.repliedTo.sender.profilePicture,
            }
        } : null,
    };
}
export function normalizeReactions(
    reactions?: Record<string, ReactionUser[]>
): { emoji: string; users: string[] }[] {
    if (!reactions) return [];

    return Object.entries(reactions).map(([emoji, users]) => ({
        emoji,
        users: (users || []).map((user) =>
            typeof user === "string"
                ? user
                : user._id
                    ? typeof user._id === "string"
                        ? user._id
                        : user._id.toString()
                    : user.toString()
        ),
    }));
}