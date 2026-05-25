import { NextRequest, NextResponse } from "next/server";
import { connectToDatabase } from "@/lib/Db/db";
import { authGoogleCallbackRateLimiter } from "@/lib/utils/rateLimiter";
import {
    buildAccessTokenCookie,
    buildRefreshTokenCookie,
    logAuthEventBestEffort,
    loginWithGoogleCode,
} from "@chat/auth";

const GOOGLE_STATE_COOKIE = "google_oauth_state";
const GOOGLE_CALLBACK_COOKIE = "google_oauth_callback";

function getAppBaseUrl(req: NextRequest): string {
    return (
        process.env.APP_URL ||
        process.env.NEXT_PUBLIC_APP_URL ||
        req.nextUrl.origin
    );
}

function getRedirectUri(req: NextRequest): string {
    return `${getAppBaseUrl(req)}/api/auth/google/callback`;
}

function cleanupOAuthCookies(response: NextResponse) {
    response.cookies.set({
        name: GOOGLE_STATE_COOKIE,
        value: "",
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        path: "/",
        maxAge: 0,
    });

    response.cookies.set({
        name: GOOGLE_CALLBACK_COOKIE,
        value: "",
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        path: "/",
        maxAge: 0,
    });
}

function toLoginErrorCode(message: string): string {
    if (message.includes("redirect_uri_mismatch")) {
        return "google_redirect_uri_mismatch";
    }

    if (message.includes("invalid_grant")) {
        return "google_invalid_grant";
    }

    if (message.startsWith("Google token exchange failed:")) {
        return "google_token_exchange_failed";
    }

    if (message === "GOOGLE_ACCOUNT_NOT_LINKED") {
        return "google_account_not_linked";
    }

    if (message === "GOOGLE_IDENTITY_MISMATCH") {
        return "google_identity_mismatch";
    }

    if (message === "Google account email is missing or unverified") {
        return "google_unverified_email";
    }

    if (message === "ACCOUNT_DELETED") {
        return "account_deleted";
    }

    return "google_oauth_failed";
}

export async function GET(req: NextRequest) {
    const xForwardedFor = req.headers.get("x-forwarded-for") || "";
    const ipAddress = xForwardedFor.split(",")[0]?.trim() || "unknown";
    const userAgent = req.headers.get("user-agent") || undefined;
    const deviceId = req.headers.get("x-device-id") || undefined;
    const { success } = await authGoogleCallbackRateLimiter.limit(ipAddress);
    if (!success) {
        await logAuthEventBestEffort({
            eventType: "google_oauth_failed",
            outcome: "failure",
            ipAddress,
            userAgent,
            reason: "rate_limited",
        });
        const loginRedirect = new URL("/login", req.url);
        loginRedirect.searchParams.set("error", "too_many_google_oauth_attempts");
        return NextResponse.redirect(loginRedirect);
    }

    const code = req.nextUrl.searchParams.get("code");
    const state = req.nextUrl.searchParams.get("state");

    const storedState = req.cookies.get(GOOGLE_STATE_COOKIE)?.value;
    const callbackCookie = req.cookies.get(GOOGLE_CALLBACK_COOKIE)?.value;
    const callbackUrl = callbackCookie ? decodeURIComponent(callbackCookie) : "/";

    const loginRedirect = new URL("/login", req.url);

    if (!code || !state || !storedState || state !== storedState) {
        await logAuthEventBestEffort({
            eventType: "google_oauth_failed",
            outcome: "failure",
            ipAddress,
            userAgent,
            reason: "invalid_oauth_state",
        });
        loginRedirect.searchParams.set("error", "google_oauth_state");
        const response = NextResponse.redirect(loginRedirect);
        cleanupOAuthCookies(response);
        return response;
    }

    try {
        await connectToDatabase();

        const { user, accessToken, refreshToken } = await loginWithGoogleCode({
            code,
            redirectUri: getRedirectUri(req),
            deviceId,
            userAgent,
            ipAddress,
        });

        await logAuthEventBestEffort({
            eventType: "google_oauth_success",
            outcome: "success",
            userId: user._id.toString(),
            email: user.email,
            ipAddress,
            userAgent,
        });

        const safeRedirect = callbackUrl.startsWith("/") ? callbackUrl : "/";
        const response = NextResponse.redirect(new URL(safeRedirect, req.url));
        cleanupOAuthCookies(response);
        response.headers.append("Set-Cookie", buildAccessTokenCookie(accessToken));
        response.headers.append("Set-Cookie", buildRefreshTokenCookie(refreshToken));

        return response;
    } catch (error) {
        const message = error instanceof Error ? error.message : "google_oauth_failed";
        if (process.env.NODE_ENV !== "production") {
            console.error("[auth][google-callback]", {
                message,
                redirectUri: getRedirectUri(req),
            });
        }
        await logAuthEventBestEffort({
            eventType: "google_oauth_failed",
            outcome: "failure",
            ipAddress,
            userAgent,
            reason: message,
        });
        loginRedirect.searchParams.set("error", toLoginErrorCode(message));
        const response = NextResponse.redirect(loginRedirect);
        cleanupOAuthCookies(response);
        return response;
    }
}
