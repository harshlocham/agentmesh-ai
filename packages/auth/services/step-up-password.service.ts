import { comparePassword } from "../password/compare";
import { revokeSession, rotateSessionTokenHash } from "../repositories/session.repo";
import { verifySession } from "../session/verify-session";
import { hashToken } from "../session/token-hash";
import { generateAccessToken, generateRefreshToken } from "../tokens/generate";
import { User } from "@/models/User";
import { getChallengeById, markChallengeVerified } from "@/models/StepUpChallenge";

type CompletePasswordStepUpInput = {
    challengeId: string;
    password: string;
    refreshToken: string;
};

export async function completePasswordStepUpChallenge({
    challengeId,
    password,
    refreshToken,
}: CompletePasswordStepUpInput) {
    // Verify the session first so we can authoritatively revoke it if the
    // challenge turns out to be expired or invalid.
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

    const user = await User.findById(payload.sub)
        .select("_id password role status tokenVersion")
        .lean<{
            _id: { toString(): string };
            password?: string;
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

    if (!user.password) {
        throw new Error("Password authentication not available for this account");
    }

    const passwordMatches = await comparePassword(password, user.password);
    if (!passwordMatches) {
        throw new Error("Invalid password");
    }

    const currentTokenVersion = user.tokenVersion || 0;
    if (payload.tokenVersion !== currentTokenVersion) {
        await revokeSession(payload.sessionId);
        throw new Error("Token version revoked");
    }

    // Single-use guard: only one concurrent verification can flip pending -> verified.
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
