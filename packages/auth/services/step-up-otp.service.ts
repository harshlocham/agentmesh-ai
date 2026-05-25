import { randomInt } from "node:crypto";
import { comparePassword } from "../password/compare";
import { hashPassword } from "../password/hash";
import { rotateSessionTokenHash } from "../repositories/session.repo";
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
    const challenge = await getChallengeById(challengeId);
    if (!challenge) {
        throw new Error("Challenge not found");
    }

    if (challenge.status !== "pending") {
        throw new Error("Challenge is not pending");
    }

    if (challenge.expiresAt.getTime() <= Date.now()) {
        throw new Error("Challenge expired");
    }

    if (challenge.otp?.sentAt && challenge.otp.sentAt.getTime() > Date.now() - OTP_RESEND_COOLDOWN_MS) {
        throw new Error("Please wait before requesting another OTP");
    }

    const { payload } = await verifySession(refreshToken);

    if (String(challenge.userId) !== payload.sub) {
        throw new Error("Challenge user mismatch");
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
    const challenge = await getChallengeById(challengeId);
    if (!challenge) {
        throw new Error("Challenge not found");
    }

    if (challenge.status !== "pending") {
        throw new Error("Challenge is not pending");
    }

    if (challenge.expiresAt.getTime() <= Date.now()) {
        throw new Error("Challenge expired");
    }

    if (!challenge.otp?.hash) {
        throw new Error("OTP has not been requested");
    }

    const { payload } = await verifySession(refreshToken);

    if (String(challenge.userId) !== payload.sub) {
        throw new Error("Challenge user mismatch");
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
        throw new Error("Invalid OTP");
    }

    const currentTokenVersion = user.tokenVersion || 0;
    if (payload.tokenVersion !== currentTokenVersion) {
        throw new Error("Token version revoked");
    }

    const verifiedChallenge = await markChallengeVerified(challengeId);
    if (!verifiedChallenge) {
        throw new Error("Challenge is no longer valid");
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
        challengeId,
    };
}