import { NextRequest, NextResponse } from "next/server";
import {
    authConfig,
    buildAccessTokenCookie,
    buildRefreshTokenCookie,
    completePasswordStepUpChallenge,
    logAuthEventBestEffort,
} from "@chat/auth";

type ChallengePasswordBody = {
    challengeId?: unknown;
    password?: unknown;
    refreshToken?: unknown;
};

function safeIpAddress(req: NextRequest): string {
    const xForwardedFor = req.headers.get("x-forwarded-for") || "";
    return xForwardedFor
        .split(",")
        .map((entry) => entry.trim())
        .find(Boolean) || "unknown";
}

async function parseBody(req: NextRequest): Promise<ChallengePasswordBody> {
    try {
        const body = (await req.json()) as unknown;
        if (!body || typeof body !== "object") {
            return {};
        }
        return body as ChallengePasswordBody;
    } catch {
        return {};
    }
}

export async function POST(req: NextRequest) {
    const ipAddress = safeIpAddress(req);
    const userAgent = req.headers.get("user-agent") || undefined;

    const body = await parseBody(req);
    const challengeId = typeof body.challengeId === "string" ? body.challengeId.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const bodyRefreshToken = typeof body.refreshToken === "string" ? body.refreshToken.trim() : "";
    const cookieRefreshToken = req.cookies.get(authConfig.cookie.refreshToken)?.value || "";
    const refreshToken = bodyRefreshToken || cookieRefreshToken;

    if (!challengeId || !password || !refreshToken) {
        await logAuthEventBestEffort({
            eventType: "step_up_failed",
            outcome: "failure",
            ipAddress,
            userAgent,
            reason: "missing_required_fields",
            metadata: { challengeId: challengeId || undefined },
        });

        return NextResponse.json(
            { success: false, error: "challengeId, password and refresh token are required" },
            { status: 400 }
        );
    }

    try {
        const tokens = await completePasswordStepUpChallenge({
            challengeId,
            password,
            refreshToken,
        });

        await logAuthEventBestEffort({
            eventType: "step_up_success",
            outcome: "success",
            userId: tokens.userId,
            ipAddress,
            userAgent,
            metadata: {
                challengeId: tokens.challengeId,
                sessionId: tokens.sessionId,
            },
        });

        const response = NextResponse.json({
            success: true,
            challengeId: tokens.challengeId,
        });
        response.headers.append("Set-Cookie", buildAccessTokenCookie(tokens.accessToken));
        response.headers.append("Set-Cookie", buildRefreshTokenCookie(tokens.refreshToken));
        return response;
    } catch (error) {
        const reason = error instanceof Error ? error.message : "unknown_error";
        const status =
            reason === "Challenge not found"
                ? 404
                : reason === "Challenge expired" ||
                    reason === "Challenge is not pending" ||
                    reason === "Challenge is no longer valid"
                    ? 409
                    : reason === "Password authentication not available for this account"
                        ? 422
                        : reason === "Invalid password" ||
                            reason === "Invalid session" ||
                            reason === "Session revoked" ||
                            reason === "Session expired" ||
                            reason === "Invalid session token" ||
                            reason === "Invalid refresh token payload" ||
                            reason === "Invalid refresh token"
                            ? 401
                            : 400;

        await logAuthEventBestEffort({
            eventType: "step_up_failed",
            outcome: "failure",
            ipAddress,
            userAgent,
            reason,
            metadata: { challengeId },
        });

        return NextResponse.json(
            {
                success: false,
                error: "STEP_UP_VERIFICATION_FAILED",
                reason,
            },
            { status }
        );
    }
}
