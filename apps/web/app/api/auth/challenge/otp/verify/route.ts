import { NextRequest, NextResponse } from "next/server";
import { connectToDatabase } from "@/lib/Db/db";
import {
    authConfig,
    buildAccessTokenCookie,
    buildRefreshTokenCookie,
    completeOtpStepUpChallenge,
    logAuthEventBestEffort,
} from "@chat/auth";

type ChallengeOtpVerifyBody = {
    challengeId?: unknown;
    otp?: unknown;
    refreshToken?: unknown;
};

function safeIpAddress(req: NextRequest): string {
    const xForwardedFor = req.headers.get("x-forwarded-for") || "";
    return xForwardedFor
        .split(",")
        .map((entry) => entry.trim())
        .find(Boolean) || "unknown";
}

async function parseBody(req: NextRequest): Promise<ChallengeOtpVerifyBody> {
    try {
        const body = (await req.json()) as unknown;
        if (!body || typeof body !== "object") {
            return {};
        }
        return body as ChallengeOtpVerifyBody;
    } catch {
        return {};
    }
}

export async function POST(req: NextRequest) {
    const ipAddress = safeIpAddress(req);
    const userAgent = req.headers.get("user-agent") || undefined;

    const body = await parseBody(req);
    const challengeId = typeof body.challengeId === "string" ? body.challengeId.trim() : "";
    const otp = typeof body.otp === "string" ? body.otp.trim() : "";
    const bodyRefreshToken = typeof body.refreshToken === "string" ? body.refreshToken.trim() : "";
    const cookieRefreshToken = req.cookies.get(authConfig.cookie.refreshToken)?.value || "";
    const refreshToken = bodyRefreshToken || cookieRefreshToken;

    if (!challengeId || !otp || !refreshToken) {
        await logAuthEventBestEffort({
            eventType: "step_up_failed",
            outcome: "failure",
            ipAddress,
            userAgent,
            reason: "missing_required_fields",
            metadata: { challengeId: challengeId || undefined, method: "otp" },
        });

        return NextResponse.json(
            { success: false, error: "challengeId, otp and refresh token are required" },
            { status: 400 }
        );
    }

    try {
        await connectToDatabase();

        const tokens = await completeOtpStepUpChallenge({
            challengeId,
            otp,
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
                method: "otp",
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
                    : reason === "Invalid OTP" ||
                        reason === "OTP has not been requested"
                        ? 400
                        : reason === "Invalid session" ||
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
            metadata: { challengeId, method: "otp" },
        });

        return NextResponse.json(
            {
                success: false,
                error: "STEP_UP_OTP_VERIFICATION_FAILED",
                reason,
            },
            { status }
        );
    }
}