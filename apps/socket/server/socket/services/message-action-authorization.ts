import { postToInternalWebApi } from "./internal-web-bridge.js";

export type MessageAction = "edit" | "delete";

export type AuthorizeMessageActionInput = {
    action: MessageAction;
    actorUserId: string;
    conversationId: string;
    messageId: string;
    text?: string;
};

type AuthorizeMessageActionResponse = {
    allowed: boolean;
    reason?: string;
};

export async function authorizeMessageAction(
    payload: AuthorizeMessageActionInput
): Promise<AuthorizeMessageActionResponse> {
    const data = await postToInternalWebApi<AuthorizeMessageActionResponse>({
        path: "/api/internal/socket/authorize-message-action",
        body: payload,
    });

    if (!data) {
        return { allowed: false, reason: "authorization_service_unavailable" };
    }

    return {
        allowed: Boolean(data.allowed),
        reason: data.reason,
    };
}
