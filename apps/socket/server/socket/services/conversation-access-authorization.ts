import { postToInternalWebApi } from "./internal-web-bridge.js";

export type AuthorizeConversationAccessInput = {
    userId: string;
    conversationId: string;
    userRole?: "user" | "moderator" | "admin";
};

export type AuthorizeConversationAccessResponse = {
    allowed: boolean;
    participantIds?: string[];
    reason?: string;
};

export async function authorizeConversationAccess(
    payload: AuthorizeConversationAccessInput
): Promise<AuthorizeConversationAccessResponse> {
    const data = await postToInternalWebApi<AuthorizeConversationAccessResponse>({
        path: "/api/internal/socket/authorize-conversation-access",
        body: payload,
    });

    if (!data) {
        return { allowed: false, reason: "authorization_service_unavailable" };
    }

    return {
        allowed: Boolean(data.allowed),
        participantIds: Array.isArray(data.participantIds) ? data.participantIds : [],
        reason: data.reason,
    };
}
