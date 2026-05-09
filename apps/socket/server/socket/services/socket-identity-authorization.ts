import { createInternalRequestHeaders } from "@chat/types/utils/internal-bridge-auth";
import { resolveInternalBaseUrl } from "../utils/url.js";

type SocketIdentityAuthorizationResponse = {
    allowed: boolean;
    role?: "user" | "moderator" | "admin";
    reason?: string;
};

type AuthorizeSocketIdentityInput = {
    userId: string;
    tokenVersion?: number;
};

function normalizeUrl(value: string): string {
    return value.trim().replace(/\/$/, "");
}

function getInternalWebServerUrls(): string[] {
    const configuredWeb = process.env.WEB_SERVER_URL?.trim();
    const configuredOrigin = process.env.ORIGIN
        ?.split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);

    const candidates = [
        configuredWeb,
        ...(configuredOrigin ?? []),
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://localhost:3002",
        "http://127.0.0.1:3002",
    ].filter(Boolean) as string[];

    return Array.from(
        new Set(
            candidates
                .map((candidate) => resolveInternalBaseUrl(candidate) ?? normalizeUrl(candidate))
                .filter(Boolean)
        )
    );
}

export async function authorizeSocketIdentity(
    payload: AuthorizeSocketIdentityInput
): Promise<SocketIdentityAuthorizationResponse> {
    const urls = getInternalWebServerUrls();

    for (const baseUrl of urls) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5_000);

        try {
            const response = await fetch(
                `${baseUrl}/api/internal/socket/authorize-identity`,
                {
                    method: "POST",
                    headers: createInternalRequestHeaders(),
                    body: JSON.stringify(payload),
                    signal: controller.signal,
                }
            );

            if (!response.ok) {
                continue;
            }

            const data = (await response.json()) as SocketIdentityAuthorizationResponse;
            return {
                allowed: Boolean(data?.allowed),
                role: data?.role,
                reason: data?.reason,
            };
        } catch {
            // Try next candidate URL.
        } finally {
            clearTimeout(timeout);
        }
    }

    return { allowed: false, reason: "authorization_service_unavailable" };
}
