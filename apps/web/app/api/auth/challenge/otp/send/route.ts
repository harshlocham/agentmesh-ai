import { NextRequest, NextResponse } from "next/server";
import { connectToDatabase } from "@/lib/Db/db";
import { sendOtpEmail } from "@/lib/utils/sendOtp";
import { authRateLimiter } from "@/lib/utils/rateLimiter";
import {
    authConfig,
    logAuthEventBestEffort,
    requestOtpStepUpChallenge,
} from "@chat/auth";

type ChallengeOtpSendBody = {
    challengeId?: unknown;
    refreshToken?: unknown;
};

function safeIpAddress(req: NextRequest): string {
    const xForwardedFor = req.headers.get("x-forwarded-for") || "";
    return xForwardedFor
        .split(",")
        .map((entry) => entry.trim())
        .find(Boolean) || "unknown";
}

async function parseBody(req: NextRequest): Promise<ChallengeOtpSendBody> {
    try {
        const body = (await req.json()) as unknown;
        if (!body || typeof body !== "object") {
            return {};
        }
        return body as ChallengeOtpSendBody;
    } catch {
        return {};
    }
}

export async function POST(req: NextRequest) {
    const ipAddress = safeIpAddress(req);
    const userAgent = req.headers.get("user-agent") || undefined;

    const body = await parseBody(req);
    const challengeId = typeof body.challengeId === "string" ? body.challengeId.trim() : "";
    const bodyRefreshToken = typeof body.refreshToken === "string" ? body.refreshToken.trim() : "";
    const cookieRefreshToken = req.cookies.get(authConfig.cookie.refreshToken)?.value || "";
    const refreshToken = bodyRefreshToken || cookieRefreshToken;

    if (!challengeId || !refreshToken) {
        await logAuthEventBestEffort({
            eventType: "step_up_failed",
            outcome: "failure",
            ipAddress,
            userAgent,
            reason: "missing_required_fields",
            metadata: { challengeId: challengeId || undefined, method: "otp" },
        });

        return NextResponse.json(
            { success: false, error: "challengeId and refresh token are required" },
            { status: 400 }
        );
    }

    const rateLimitKey = `${ipAddress}:${challengeId}`;
    const { success } = await authRateLimiter.limit(rateLimitKey);
    if (!success) {
        return NextResponse.json(
            { success: false, error: "Too many attempts. Try again later." },
            { status: 429 }
        );
    }

    try {
        await connectToDatabase();

        const challenge = await requestOtpStepUpChallenge({ challengeId, refreshToken });
        await sendOtpEmail(challenge.email, challenge.otp);

        await logAuthEventBestEffort({
            eventType: "step_up_triggered",
            outcome: "success",
            ipAddress,
            userAgent,
            userId: challenge.userId,
            metadata: {
                challengeId: challenge.challengeId,
                method: "otp",
            },
        });

        return NextResponse.json({
            success: true,
            challengeId: challenge.challengeId,
            expiresAt: challenge.expiresAt.toISOString(),
        });
    } catch (error) {
        const reason = error instanceof Error ? error.message : "unknown_error";
        const status =
            reason === "Challenge not found"
                ? 404
                : reason === "Challenge expired" ||
                    reason === "Challenge is not pending" ||
                    reason === "Challenge is no longer valid"
                    ? 409
                    : reason === "Please wait before requesting another OTP"
                        ? 429
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
                error: "STEP_UP_OTP_SEND_FAILED",
                reason,
            },
            { status }
        );
    }
}