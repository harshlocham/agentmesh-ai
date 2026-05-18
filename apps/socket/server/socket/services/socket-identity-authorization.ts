import { postToInternalWebApi } from "./internal-web-bridge.js";

type SocketIdentityAuthorizationResponse = {
    allowed: boolean;
    role?: "user" | "moderator" | "admin";
    reason?: string;
};

type AuthorizeSocketIdentityInput = {
    userId: string;
    tokenVersion?: number;
};

export async function authorizeSocketIdentity(
    payload: AuthorizeSocketIdentityInput
): Promise<SocketIdentityAuthorizationResponse> {
    const data = await postToInternalWebApi<SocketIdentityAuthorizationResponse>({
        path: "/api/internal/socket/authorize-identity",
        body: payload,
    });

    if (!data) {
        return { allowed: false, reason: "authorization_service_unavailable" };
    }

    return {
        allowed: Boolean(data.allowed),
        role: data.role,
        reason: data.reason,
    };
}
