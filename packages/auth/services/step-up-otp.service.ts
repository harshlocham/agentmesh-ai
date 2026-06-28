import { randomInt } from "node:crypto";
import { comparePassword } from "../password/compare";
import { hashPassword } from "../password/hash";
import { revokeSession, rotateSessionTokenHash } from "../repositories/session.repo";
import { verifySession } from "../session/verify-session";
import { hashToken } from "../session/token-hash";
import { generateAccessToken, generateRefreshToken } from "../tokens/generate";
import { User } from "@/models/User";
import { getChallengeById, markChallengeVerified, recordChallengeOtp } from "@/models/StepUpChallenge";

const OTP_RESEND_COOLDOWN_MS = 60 * 1000;

type RequestOtpStepUpInput = {
    challengeId: string;
    refreshToken: string;
};

type CompleteOtpStepUpInput = {
    challengeId: string;
    otp: string;
    refreshToken: string;
};

function generateOtpCode(): string {
    return randomInt(100000, 1000000).toString();
}

export async function requestOtpStepUpChallenge({
    challengeId,
    refreshToken,
}: RequestOtpStepUpInput) {
    const { payload, session } = await verifySession(refreshToken);

    if (session.state !== "step_up_pending") {
        throw new Error("Session is not pending step-up");
    }

    const challenge = await getChallengeById(challengeId);
    if (!challenge) {
        await revokeSession(payload.sessionId);
        throw new Error("Challenge not found");
    }

    if (String(challenge.userId) !== payload.sub) {
        await revokeSession(payload.sessionId);
        throw new Error("Challenge user mismatch");
    }

    if (String(challenge.sessionId) !== payload.sessionId) {
        await revokeSession(payload.sessionId);
        throw new Error("Challenge session mismatch");
    }

    if (challenge.status !== "pending") {
        await revokeSession(payload.sessionId);
        throw new Error("Challenge is not pending");
    }

    if (challenge.expiresAt.getTime() <= Date.now()) {
        await revokeSession(payload.sessionId);
        throw new Error("Challenge expired");
    }

    if (challenge.otp?.sentAt && challenge.otp.sentAt.getTime() > Date.now() - OTP_RESEND_COOLDOWN_MS) {
        // Cooldown is a transient, retryable condition: keep the session pending.
        throw new Error("Please wait before requesting another OTP");
    }

    const user = await User.findById(payload.sub)
        .select("_id email role status tokenVersion")
        .lean<{
            _id: { toString(): string };
            email?: string;
            role?: "user" | "moderator" | "admin";
            status?: "active" | "banned";
            tokenVersion?: number;
        } | null>();

    if (!user) {
        throw new Error("User not found");
    }

    if (user.status && user.status !== "active") {
        throw new Error("Account is not active");
    }

    if (!user.email) {
        throw new Error("Email address is required for OTP verification");
    }

    const otp = generateOtpCode();
    const otpHash = await hashPassword(otp);

    const updatedChallenge = await recordChallengeOtp(challengeId, otpHash);
    if (!updatedChallenge) {
        throw new Error("Challenge is no longer valid");
    }

    return {
        challengeId,
        userId: user._id.toString(),
        email: user.email,
        otp,
        expiresAt: updatedChallenge.expiresAt,
    };
}

export async function completeOtpStepUpChallenge({
    challengeId,
    otp,
    refreshToken,
}: CompleteOtpStepUpInput) {
    const { payload, session } = await verifySession(refreshToken);

    if (session.state !== "step_up_pending") {
        throw new Error("Session is not pending step-up");
    }

    const challenge = await getChallengeById(challengeId);
    if (!challenge) {
        await revokeSession(payload.sessionId);
        throw new Error("Challenge not found");
    }

    if (String(challenge.userId) !== payload.sub) {
        await revokeSession(payload.sessionId);
        throw new Error("Challenge user mismatch");
    }

    if (String(challenge.sessionId) !== payload.sessionId) {
        await revokeSession(payload.sessionId);
        throw new Error("Challenge session mismatch");
    }

    if (challenge.status !== "pending") {
        await revokeSession(payload.sessionId);
        throw new Error("Challenge is not pending");
    }

    if (challenge.expiresAt.getTime() <= Date.now()) {
        await revokeSession(payload.sessionId);
        throw new Error("Challenge expired");
    }

    if (!challenge.otp?.hash) {
        throw new Error("OTP has not been requested");
    }

    const user = await User.findById(payload.sub)
        .select("_id email role status tokenVersion")
        .lean<{
            _id: { toString(): string };
            email?: string;
            role?: "user" | "moderator" | "admin";
            status?: "active" | "banned";
            tokenVersion?: number;
        } | null>();

    if (!user) {
        throw new Error("User not found");
    }

    if (user.status && user.status !== "active") {
        throw new Error("Account is not active");
    }

    const otpMatches = await comparePassword(otp.trim(), challenge.otp.hash);
    if (!otpMatches) {
        // Wrong OTP is retryable while the challenge remains valid (TTL-bounded).
        throw new Error("Invalid OTP");
    }

    const currentTokenVersion = user.tokenVersion || 0;
    if (payload.tokenVersion !== currentTokenVersion) {
        await revokeSession(payload.sessionId);
        throw new Error("Token version revoked");
    }

    const verifiedChallenge = await markChallengeVerified(challengeId);
    if (!verifiedChallenge) {
        await revokeSession(payload.sessionId);
        throw new Error("Challenge is no longer valid");
    }

    const nextRefreshToken = generateRefreshToken({
        sub: payload.sub,
        sessionId: payload.sessionId,
        tokenVersion: currentTokenVersion,
        type: "refresh",
    });

    // rotateSessionTokenHash also restores the session state to "active".
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
        challengeId,
    };
}