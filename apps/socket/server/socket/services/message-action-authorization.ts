import {
    createInternalRequestHeaders,
} from "@chat/types/utils/internal-bridge-auth";
import { resolveInternalBaseUrl } from "../utils/url.js";

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

function getInternalWebServerUrl(): string {
    const candidates = [
        process.env.WEB_SERVER_URL?.trim(),
        process.env.ORIGIN?.trim(),
        "http://localhost:3000",
    ].filter(Boolean) as string[];

    for (const candidate of candidates) {
        const resolved = resolveInternalBaseUrl(candidate);
        if (resolved) {
            return resolved;
        }
    }

    return "http://localhost:3000";
}

export async function authorizeMessageAction(
    payload: AuthorizeMessageActionInput
): Promise<AuthorizeMessageActionResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);

    try {
        const response = await fetch(
            `${getInternalWebServerUrl()}/api/internal/socket/authorize-message-action`,
            {
                method: "POST",
                headers: createInternalRequestHeaders(),
                body: JSON.stringify(payload),
                signal: controller.signal,
            }
        );

        if (!response.ok) {
            return { allowed: false, reason: "authorization_service_unavailable" };
        }

        const data = (await response.json()) as AuthorizeMessageActionResponse;
        return {
            allowed: Boolean(data?.allowed),
            reason: data?.reason,
        };
    } catch {
        return { allowed: false, reason: "authorization_service_error" };
    } finally {
        clearTimeout(timeout);
    }
}
