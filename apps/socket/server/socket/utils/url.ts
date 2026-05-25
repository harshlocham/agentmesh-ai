function trimUrlValue(value: string): string {
    return value.trim().replace(/\/$/, "");
}

function parseUrlLikeValue(value: string, defaultProtocol?: "http:" | "https:"): URL | null {
    const trimmed = trimUrlValue(value);
    if (!trimmed) return null;

    try {
        return new URL(trimmed);
    } catch {
        if (!defaultProtocol) {
            return null;
        }

        try {
            return new URL(`${defaultProtocol}//${trimmed}`);
        } catch {
            return null;
        }
    }
}

export function parseCommaSeparatedValues(raw: string | undefined): string[] {
    if (!raw) return [];

    return raw
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
}

export function normalizeOriginCandidate(value: string): string | null {
    return parseUrlLikeValue(value, "https:")?.origin ?? null;
}

export function normalizeHostKey(value: string): string | null {
    const parsed = parseUrlLikeValue(value, "https:");
    if (!parsed) return null;

    return `${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}`;
}

export function isOriginAllowed(origin: string | undefined, allowedOrigins: string[]): boolean {
    if (!origin) {
        return true;
    }

    if (allowedOrigins.includes("*")) {
        return true;
    }

    if (process.env.NODE_ENV !== "production") {
        if (origin.startsWith("exp://")) {
            return true;
        }

        if (
            origin.startsWith("http://localhost:")
            || origin.startsWith("http://127.0.0.1:")
            || origin.startsWith("http://10.")
            || origin.startsWith("http://192.168.")
        ) {
            return true;
        }

        if (allowedOrigins.length === 0) {
            return true;
        }
    }

    const originExact = trimUrlValue(origin);
    const originNormalized = normalizeOriginCandidate(origin);
    const originHostKey = normalizeHostKey(origin);

    for (const allowedOrigin of allowedOrigins) {
        const allowedExact = trimUrlValue(allowedOrigin);
        if (allowedExact === originExact) {
            return true;
        }

        const allowedNormalized = normalizeOriginCandidate(allowedOrigin);
        if (allowedNormalized && allowedNormalized === originNormalized) {
            return true;
        }

        const allowedHostKey = normalizeHostKey(allowedOrigin);
        if (allowedHostKey && originHostKey && allowedHostKey === originHostKey) {
            return true;
        }
    }

    return false;
}

export function resolveInternalBaseUrl(value: string): string | null {
    const defaultProtocol = process.env.NODE_ENV === "production" ? "https:" : "http:";
    return parseUrlLikeValue(value, defaultProtocol)?.origin ?? null;
}
