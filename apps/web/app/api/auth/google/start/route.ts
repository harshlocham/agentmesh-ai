import { NextRequest, NextResponse } from "next/server";
import { createGoogleOAuthState } from "@chat/auth";

const GOOGLE_STATE_COOKIE = "google_oauth_state";
const GOOGLE_CALLBACK_COOKIE = "google_oauth_callback";

function getAppBaseUrl(req: NextRequest): string {
    return (
        process.env.APP_URL ||
        process.env.NEXT_PUBLIC_APP_URL ||
        req.nextUrl.origin
    );
}

function getGoogleClientId(): string {
    return process.env.GOOGLE_CLIENT_ID || process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID || "";
}

function buildGoogleOAuthAuthorizeUrl(input: {
    clientId: string;
    redirectUri: string;
    state: string;
}): string {
    const params = new URLSearchParams({
        client_id: input.clientId,
        redirect_uri: input.redirectUri,
        response_type: "code",
        scope: "openid email profile",
        state: input.state,
        prompt: "select_account",
        access_type: "offline",
    });

    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export async function GET(req: NextRequest) {
    try {
        const callbackUrl = req.nextUrl.searchParams.get("callbackUrl") || "/";
        const baseUrl = getAppBaseUrl(req);
        const redirectUri = `${baseUrl}/api/auth/google/callback`;
        const googleClientId = getGoogleClientId();

        if (!googleClientId) {
            const loginRedirect = new URL("/login", req.url);
            loginRedirect.searchParams.set("error", "google_oauth_unavailable");
            return NextResponse.redirect(loginRedirect);
        }

        const state = createGoogleOAuthState();

        const authUrl = buildGoogleOAuthAuthorizeUrl({
            clientId: googleClientId,
            redirectUri,
            state,
        });

        const response = NextResponse.redirect(authUrl);
        response.cookies.set({
            name: GOOGLE_STATE_COOKIE,
            value: state,
            httpOnly: true,
            sameSite: "lax",
            secure: process.env.NODE_ENV === "production",
            path: "/",
            maxAge: 10 * 60,
        });

        response.cookies.set({
            name: GOOGLE_CALLBACK_COOKIE,
            value: encodeURIComponent(callbackUrl),
            httpOnly: true,
            sameSite: "lax",
            secure: process.env.NODE_ENV === "production",
            path: "/",
            maxAge: 10 * 60,
        });

        return response;
    } catch (error) {
        const message = error instanceof Error ? error.message : "Google OAuth init failed";
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
