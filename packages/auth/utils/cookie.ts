import { authConfig } from "../config";

type CookieOptions = {
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: "lax" | "strict" | "none";
    domain?: string;
    path?: string;
    maxAge?: number;
};

function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
    const parts = [name + "=" + encodeURIComponent(value)];

    if (options.maxAge !== undefined) {
        parts.push("Max-Age=" + String(options.maxAge));
    }

    parts.push("Path=" + (options.path || "/"));

    if (options.domain) {
        parts.push("Domain=" + options.domain);
    }

    if (options.httpOnly !== false) {
        parts.push("HttpOnly");
    }

    if (options.secure !== false) {
        parts.push("Secure");
    }

    parts.push("SameSite=" + (options.sameSite || "lax").toLowerCase());

    return parts.join("; ");
}

function resolveCookieDomain(): string | undefined {
    const raw = process.env.COOKIE_DOMAIN?.trim();
    if (!raw) return undefined;

    // Keep domain explicit and deterministic for cross-subdomain auth cookies.
    return raw;
}

export function buildAccessTokenCookie(token: string, maxAgeSeconds = 15 * 60): string {
    return serializeCookie(authConfig.cookie.accessToken, token, {
        maxAge: maxAgeSeconds,
        path: "/",
        domain: resolveCookieDomain(),
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
    });
}

export function buildRefreshTokenCookie(
    token: string,
    maxAgeSeconds = Math.floor(authConfig.session.refreshTtlMs / 1000)
): string {
    return serializeCookie(authConfig.cookie.refreshToken, token, {
        maxAge: maxAgeSeconds,
        path: "/",
        domain: resolveCookieDomain(),
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
    });
}

export function buildExpiredCookie(name: string): string {
    return serializeCookie(name, "", {
        maxAge: 0,
        path: "/",
        domain: resolveCookieDomain(),
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
    });
}

export function parseCookieValue(cookieHeader: string | undefined, name: string): string | null {
    if (!cookieHeader) return null;

    const pairs = cookieHeader.split(";");
    for (const pair of pairs) {
        const item = pair.trim();
        const eqIndex = item.indexOf("=");
        if (eqIndex <= 0) continue;

        const key = item.slice(0, eqIndex);
        if (key !== name) continue;

        return decodeURIComponent(item.slice(eqIndex + 1));
    }

    return null;
}