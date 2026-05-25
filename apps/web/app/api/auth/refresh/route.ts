import { NextRequest, NextResponse } from "next/server";
import { authRateLimitResponse, enforceAuthRateLimit } from "@/lib/utils/rateLimiter";
import { connectToDatabase } from "@/lib/Db/db";
import {
    AuthStepUpRequiredError,
    authConfig,
    buildAccessTokenCookie,
    buildRefreshTokenCookie,
    logAuthEventBestEffort,
    refreshService,
} from "@chat/auth";

type RequestContext = {
    ipAddress: string;
    userAgent?: string;
};

function isDevelopment() {
    return process.env.NODE_ENV !== "production";
}

function withDebug(reason: string) {
    return isDevelopment() ? { debug: reason } : {};
}

function classifyRefreshFailureReason(errorMessage: string): string {
    const map: Record<string, string> = {
        "Invalid session": "SESSION_NOT_FOUND",
        "Invalid session user binding": "USER_MISMATCH",
        "Session revoked": "SESSION_REVOKED",
        "Session expired": "SESSION_EXPIRED",
        "Invalid session token": "TOKEN_MISMATCH",
        "Invalid refresh token payload": "INVALID_REFRESH_TOKEN",
        "jwt malformed": "INVALID_REFRESH_TOKEN",
        "jwt expired": "REFRESH_TOKEN_EXPIRED",
        "invalid signature": "INVALID_REFRESH_TOKEN_SIGNATURE",
        "User not found": "USER_NOT_FOUND",
        "Account is not active": "ACCOUNT_NOT_ACTIVE",
        "Token version revoked": "TOKEN_VERSION_REVOKED",
    };

    return map[errorMessage] || "INTERNAL_REFRESH_ERROR";
}

function isDatabaseConnectivityError(error: Error): boolean {
    return (
        error.name === "MongooseServerSelectionError" ||
        error.name === "MongoServerSelectionError" ||
        error.message.includes("buffering timed out") ||
        error.message.includes("Please define the MONGODB_URI environment variable")
    );
}

function getRequestContext(req: NextRequest): RequestContext {
    const forwardedFor = req.headers.get("x-forwarded-for") || "";
    const ipAddress =
        forwardedFor
            .split(",")
            .map((entry) => entry.trim())
            .find(Boolean) || "unknown";
    const userAgent = req.headers.get("user-agent") || undefined;

    return { ipAddress, userAgent };
}

function logRefreshFailure(
    context: RequestContext,
    reason: string,
    metadata?: Record<string, unknown>
) {
    void logAuthEventBestEffort({
        eventType: "refresh_failed",
        outcome: "failure",
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
        reason,
        metadata,
    });
}

function getCookieRefreshToken(req: NextRequest): string {
    return req.cookies.get(authConfig.cookie.refreshToken)?.value || "";
}

async function getBodyPayload(req: NextRequest): Promise<{ refreshToken: string; deviceId: string }> {
    const contentType = req.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
        return { refreshToken: "", deviceId: "" };
    }

    try {
        const body = (await req.json()) as unknown;
        if (!body || typeof body !== "object") {
            return { refreshToken: "", deviceId: "" };
        }

        const payload = body as { refreshToken?: unknown; deviceId?: unknown };

        return {
            refreshToken:
                typeof payload.refreshToken === "string"
                    ? payload.refreshToken.trim()
                    : "",
            deviceId:
                typeof payload.deviceId === "string"
                    ? payload.deviceId.trim()
                    : "",
        };
    } catch {
        return { refreshToken: "", deviceId: "" };
    }
}

export async function POST(req: NextRequest) {
    const context = getRequestContext(req);

    try {
        const rateLimit = await enforceAuthRateLimit({
            endpoint: "refresh",
            ipAddress: context.ipAddress,
            enableBackoff: true,
        });
        if (!rateLimit.allowed) {
            logRefreshFailure(context, "rate_limited");
            return authRateLimitResponse(rateLimit);
        }

        const bodyPayload = await getBodyPayload(req);
        const bodyRefreshToken = bodyPayload.refreshToken;
        const bodyDeviceId = bodyPayload.deviceId;
        const headerDeviceId = req.headers.get("x-device-id") || "";
        const deviceId = bodyDeviceId || headerDeviceId;
        const cookieRefreshToken = getCookieRefreshToken(req);
        const refreshToken = bodyRefreshToken || cookieRefreshToken;

        if (!refreshToken) {
            logRefreshFailure(context, "missing_refresh_token");
            return NextResponse.json(
                { success: false, error: "Refresh token is required", ...withDebug("MISSING_REFRESH_TOKEN") },
                { status: 401 }
            );
        }

        // Ensure models are bound to an active DB connection before token/session queries.
        await connectToDatabase();

        const tokens = await refreshService({
            refreshToken,
            deviceId,
            userAgent: context.userAgent,
            ipAddress: context.ipAddress,
        });

        void logAuthEventBestEffort({
            eventType: "refresh_success",
            outcome: "success",
            userId: tokens.userId,
            ipAddress: context.ipAddress,
            userAgent: context.userAgent,
            metadata: { sessionId: tokens.sessionId },
        });

        const response = NextResponse.json({
            success: true,
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
        });
        response.headers.append("Set-Cookie", buildAccessTokenCookie(tokens.accessToken));
        response.headers.append("Set-Cookie", buildRefreshTokenCookie(tokens.refreshToken));

        return response;
    } catch (error) {
        if (error instanceof AuthStepUpRequiredError) {
            void logAuthEventBestEffort({
                eventType: "step_up_triggered",
                outcome: "success",
                userId: error.userId,
                ipAddress: context.ipAddress,
                userAgent: context.userAgent,
                reason: error.code,
                metadata: {
                    reasons: error.reasons,
                    challengeId: error.challengeId,
                },
            });

            const response = NextResponse.json(
                {
                    success: false,
                    error: "STEP_UP_REQUIRED",
                    challengeId: error.challengeId,
                },
                { status: error.status }
            );
            return response;
        }

        if (error instanceof Error) {
            logRefreshFailure(context, error.message);

            if (isDatabaseConnectivityError(error)) {
                return NextResponse.json(
                    {
                        success: false,
                        error: "Database unavailable",
                        ...withDebug("DATABASE_UNAVAILABLE"),
                    },
                    { status: 503 }
                );
            }

            const debugReason = classifyRefreshFailureReason(error.message);

            const knownAuthFailure = new Set([
                "Invalid session",
                "Session revoked",
                "Session expired",
                "Invalid session token",
                "Invalid session user binding",
                "User not found",
                "Account is not active",
                "Token version revoked",
                "Invalid refresh token payload",
                "jwt malformed",
                "jwt expired",
                "invalid signature",
            ]);

            const status = knownAuthFailure.has(error.message) ? 401 : 500;
            return NextResponse.json(
                { success: false, error: "Refresh failed", ...withDebug(debugReason) },
                { status }
            );
        }

        logRefreshFailure(context, "unknown_error");
        return NextResponse.json(
            { success: false, error: "Refresh failed", ...withDebug("UNKNOWN_REFRESH_ERROR") },
            { status: 500 }
        );
    }
}
