import { verifySession } from "../session/verify-session";
import { generateAccessToken, generateRefreshToken } from "../tokens/generate";
import { hashToken } from "../session/token-hash";
import {
    markSessionStepUpPending,
    revokeSession,
    rotateSessionTokenHash,
} from "../repositories/session.repo";
import { generateDeviceFingerprint, validateSessionFingerprint } from "../session/fingerprint";
import { AuthStepUpRequiredError } from "../errors/auth-errors";
import { User } from "@/models/User";
import { createChallenge, StepUpChallenge } from "@/models/StepUpChallenge";

export const refreshService = async ({
    refreshToken,
    deviceId,
    userAgent,
    ipAddress,
}: {
    refreshToken: string;
    deviceId?: string;
    userAgent?: string;
    ipAddress?: string;
}) => {
    const { payload, session } = await verifySession(refreshToken);

    const user = await User.findById(payload.sub)
        .select("_id role status tokenVersion isDeleted")
        .lean<{
            _id: { toString(): string };
            role?: "user" | "moderator" | "admin";
            status?: string;
            tokenVersion?: number;
            isDeleted?: boolean;
        } | null>();

    if (!user) {
        throw new Error("User not found");
    }

    if (user.isDeleted) {
        throw new Error("ACCOUNT_DELETED");
    }

    if (user.status && user.status !== "active") {
        throw new Error("Account is not active");
    }

    const currentTokenVersion = user.tokenVersion || 0;
    if (payload.tokenVersion !== currentTokenVersion) {
        await revokeSession(payload.sessionId);
        throw new Error("Token version revoked");
    }

    const incomingDeviceFingerprint = generateDeviceFingerprint({
        deviceId,
        userAgent,
        ipAddress,
    });

    const fingerprint = validateSessionFingerprint({
        stored: {
            deviceId: session.deviceId,
            userAgent: session.userAgent,
            ipAddress: session.ipAddress,
        },
        incoming: {
            deviceId: incomingDeviceFingerprint,
            userAgent,
            ipAddress,
        },
    });

    if (session.state === "step_up_pending") {
        const existingChallenge = await StepUpChallenge.findOne({
            userId: payload.sub,
            status: "pending",
            expiresAt: { $gt: new Date() },
        })
            .sort({ createdAt: -1 })
            .select("_id")
            .lean<{ _id: { toString(): string } } | null>();

        const challengeId = existingChallenge
            ? existingChallenge._id.toString()
            : (
                  await createChallenge(payload.sub, {
                      ip: ipAddress,
                      userAgent,
                  })
              )._id.toString();

        throw new AuthStepUpRequiredError(
            fingerprint.requiresStepUp ? fingerprint.reasons : [],
            challengeId,
            payload.sub
        );
    }

    if (fingerprint.requiresStepUp) {
        const challenge = await createChallenge(payload.sub, {
            ip: ipAddress,
            userAgent,
        });
        // Keep the session alive but gated: step-up completion must be able to
        // re-verify this same refresh session. Revoking here would make the
        // challenge impossible to complete.
        await markSessionStepUpPending(payload.sessionId);
        throw new AuthStepUpRequiredError(
            fingerprint.reasons,
            challenge._id.toString(),
            payload.sub
        );
    }

    const nextRefreshToken = generateRefreshToken({
        sub: payload.sub,
        sessionId: payload.sessionId,
        tokenVersion: currentTokenVersion,
        type: "refresh",
    });

    const rotated = await rotateSessionTokenHash(
        payload.sessionId,
        hashToken(nextRefreshToken)
    );

    if (!rotated) {
        throw new Error("Unable to rotate refresh session");
    }

    const accessToken = generateAccessToken({
        sub: user._id.toString(),
        role: user.role || "user",
        tokenVersion: currentTokenVersion,
        type: "access",
    });

    return {
        accessToken,
        refreshToken: nextRefreshToken,
        userId: user._id.toString(),
        sessionId: payload.sessionId,
    };
};
