import { createInternalRequestHeaders } from "@chat/types/utils/internal-bridge-auth";
import { resolveInternalBaseUrl } from "../utils/url.js";

function normalizeUrl(value: string): string {
    return value.trim().replace(/\/$/, "");
}

export function getInternalWebServerUrls(): string[] {
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

type PostInternalOptions = {
    path: string;
    body: unknown;
    timeoutMs?: number;
};

export async function postToInternalWebApi<TResponse>(
    options: PostInternalOptions
): Promise<TResponse | null> {
    const urls = getInternalWebServerUrls();

    for (const baseUrl of urls) {
        const controller = new AbortController();
        const timeout = setTimeout(
            () => controller.abort(),
            options.timeoutMs ?? 5_000
        );

        try {
            const response = await fetch(`${baseUrl}${options.path}`, {
                method: "POST",
                headers: createInternalRequestHeaders(),
                body: JSON.stringify(options.body),
                signal: controller.signal,
            });

            if (!response.ok) {
                continue;
            }

            return (await response.json()) as TResponse;
        } catch {
            // Try next candidate URL.
        } finally {
            clearTimeout(timeout);
        }
    }

    return null;
}
