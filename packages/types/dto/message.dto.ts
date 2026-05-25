export interface MessageDTO {
    _id: string;
    conversationId: string;

    content: string;
    messageType: "text" | "image" | "file" | "system" | "video" | "audio" | "voice";

    sender: {
        _id: string;
        username: string;
        profilePicture?: string;
    };

    createdAt: string;   // ISO string
    updatedAt?: string;  // ISO string

    semanticType?: "chat" | "task" | "decision" | "reminder" | "unknown";
    semanticConfidence?: number;
    aiStatus?: "pending" | "classified" | "failed" | "overridden";
    aiVersion?: string | null;
    linkedTaskIds?: string[];
    manualOverride?: boolean;
    overrideBy?: string | null;
    overrideAt?: string | null;
    semanticProcessedAt?: string | null;

    isDeleted?: boolean;
    isEdited?: boolean;
    editedAt?: string;
    delivered?: boolean;
    seen?: boolean;

    reactions?: {
        emoji: string;
        users: string[];
    }[];

    seenBy?: string[];
    deliveredTo?: string[];

    repliedTo?: {
        _id: string;
        content: string;
        sender: {
            _id: string;
            username: string;
            profilePicture?: string;
        };
    } | null;
}