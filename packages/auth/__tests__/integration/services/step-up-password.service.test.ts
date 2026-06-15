import { describe, expect, it } from "vitest";
import { Types } from "mongoose";
import { completePasswordStepUpChallenge } from "../../../services/step-up-password.service.js";
import { verifyAccessToken, verifyRefreshToken } from "../../../tokens/verify.js";
import { hashToken } from "../../../session/token-hash.js";
import {
    findSessionById,
    findSessionByIdWithToken,
    markSessionStepUpPending,
} from "../../../repositories/session.repo.js";
import { StepUpChallenge } from "../../../../db/models/StepUpChallenge.js";
import { useTestDb } from "../../helpers/db.js";
import { objectId } from "../../helpers/ids.js";
import { createUser } from "../../helpers/factories/user.factory.js";
import {
    issueRefreshTokenForSession,
    mintRefreshToken,
} from "../../helpers/factories/refresh-token.factory.js";
import {
    createPendingPasswordChallenge,
    createExpiredChallenge,
    createVerifiedChallenge,
} from "../../helpers/factories/step-up-challenge.factory.js";

useTestDb();

const PASSWORD = "s3cret-step-up-p4ss";
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Refresh-token rotation only yields a byte-different token once the wall clock
// crosses a 1-second boundary (the signer is deterministic over payload + iat).
const ROTATION_DELAY_MS = 1200;

interface StepUpSetup {
    userId: string;
    issued: Awaited<ReturnType<typeof issueRefreshTokenForSession>>;
    challengeId: string;
}

/**
 * Create a real password user, a step_up_pending session whose refresh token
 * verifies, and a pending password challenge bound to that user.
 */
async function setupStepUp(opts: {
    userTokenVersion?: number;
    sessionTokenVersion?: number;
    role?: "user" | "moderator" | "admin";
    status?: "active" | "banned";
    plainPassword?: string | null;
    createUserDoc?: boolean;
    challengeUserId?: string;
} = {}): Promise<StepUpSetup> {
    const userTokenVersion = opts.userTokenVersion ?? 0;
    const sessionTokenVersion = opts.sessionTokenVersion ?? userTokenVersion;

    let userId: string;
    if (opts.createUserDoc === false) {
        userId = objectId();
    } else {
        const user = await createUser({
            plainPassword: opts.plainPassword === null ? undefined : opts.plainPassword ?? PASSWORD,
            authProviders: opts.plainPassword === null ? ["google"] : ["password"],
            googleSub: opts.plainPassword === null ? `google-${objectId()}` : undefined,
            tokenVersion: userTokenVersion,
            role: opts.role ?? "user",
            status: opts.status ?? "active",
        });
        userId = user._id.toString();
    }

    const issued = await issueRefreshTokenForSession({
        userId,
        tokenVersion: sessionTokenVersion,
        state: "step_up_pending",
    });

    const challenge = await createPendingPasswordChallenge({
        userId: opts.challengeUserId ?? userId,
    });

    return { userId, issued, challengeId: challenge._id.toString() };
}

async function challengeStatus(challengeId: string): Promise<string | undefined> {
    const doc = await StepUpChallenge.findById(challengeId);
    return doc?.status;
}

describe("services/step-up-password.service (db integration)", () => {
    describe("happy path", () => {
        it("completes the challenge with the correct password (req 1)", async () => {
            const { userId, issued, challengeId } = await setupStepUp();

            const result = await completePasswordStepUpChallenge({
                challengeId,
                password: PASSWORD,
                refreshToken: issued.refreshToken,
            });

            expect(result.userId).toBe(userId);
            expect(result.sessionId).toBe(issued.sessionId);
            expect(result.challengeId).toBe(challengeId);
            expect(result.accessToken).toBeTruthy();
            expect(result.refreshToken).toBeTruthy();
        });

        it("marks the challenge as verified (req 2)", async () => {
            const { issued, challengeId } = await setupStepUp();

            await completePasswordStepUpChallenge({
                challengeId,
                password: PASSWORD,
                refreshToken: issued.refreshToken,
            });

            expect(await challengeStatus(challengeId)).toBe("verified");
        });

        it("restores the session to active (req 3)", async () => {
            const { issued, challengeId } = await setupStepUp();

            await completePasswordStepUpChallenge({
                challengeId,
                password: PASSWORD,
                refreshToken: issued.refreshToken,
            });

            const session = await findSessionById(issued.sessionId);
            expect(session?.state).toBe("active");
            expect(session?.revokedAt).toBeNull();
        });

        it("rotates the refresh token and updates the stored hash (req 4)", async () => {
            const { issued, challengeId } = await setupStepUp();

            await sleep(ROTATION_DELAY_MS);
            const result = await completePasswordStepUpChallenge({
                challengeId,
                password: PASSWORD,
                refreshToken: issued.refreshToken,
            });

            expect(result.refreshToken).not.toBe(issued.refreshToken);
            const refreshPayload = verifyRefreshToken(result.refreshToken);
            expect(refreshPayload.sessionId).toBe(issued.sessionId);

            const stored = await findSessionByIdWithToken(issued.sessionId);
            expect(stored?.refreshTokenHash).toBe(hashToken(result.refreshToken));
            expect(stored?.refreshTokenHash).not.toBe(issued.refreshTokenHash);
        });

        it("issues an access token carrying the user's role and tokenVersion (req 5)", async () => {
            const { userId, issued, challengeId } = await setupStepUp({
                role: "moderator",
                userTokenVersion: 3,
                sessionTokenVersion: 3,
            });

            const result = await completePasswordStepUpChallenge({
                challengeId,
                password: PASSWORD,
                refreshToken: issued.refreshToken,
            });

            const accessPayload = verifyAccessToken(result.accessToken);
            expect(accessPayload.sub).toBe(userId);
            expect(accessPayload.role).toBe("moderator");
            expect(accessPayload.tokenVersion).toBe(3);
        });
    });

    describe("failure", () => {
        it("rejects a wrong password WITHOUT revoking the session (retryable) (req 6)", async () => {
            const { issued, challengeId } = await setupStepUp();

            await expect(
                completePasswordStepUpChallenge({
                    challengeId,
                    password: "wrong-password",
                    refreshToken: issued.refreshToken,
                })
            ).rejects.toThrow("Invalid password");

            // Session stays pending and the challenge stays pending: the user can retry.
            const session = await findSessionById(issued.sessionId);
            expect(session?.state).toBe("step_up_pending");
            expect(session?.revokedAt).toBeNull();
            expect(await challengeStatus(challengeId)).toBe("pending");
        });

        it("revokes the session when the challenge is missing (req 7)", async () => {
            const { issued } = await setupStepUp();

            await expect(
                completePasswordStepUpChallenge({
                    challengeId: objectId(),
                    password: PASSWORD,
                    refreshToken: issued.refreshToken,
                })
            ).rejects.toThrow("Challenge not found");

            const session = await findSessionById(issued.sessionId);
            expect(session?.revokedAt).toBeInstanceOf(Date);
        });

        it("FINDING: an expired challenge reports 'Challenge is not pending' (not 'Challenge expired') (req 8)", async () => {
            const user = await createUser({ plainPassword: PASSWORD });
            const userId = user._id.toString();
            const issued = await issueRefreshTokenForSession({
                userId,
                state: "step_up_pending",
            });
            const challenge = await createExpiredChallenge({ userId });

            // getChallengeById() lazily flips the expired-but-pending row to
            // "expired", so the service's dedicated "Challenge expired" branch is
            // unreachable; the status check fires first.
            await expect(
                completePasswordStepUpChallenge({
                    challengeId: challenge._id.toString(),
                    password: PASSWORD,
                    refreshToken: issued.refreshToken,
                })
            ).rejects.toThrow("Challenge is not pending");

            expect(await challengeStatus(challenge._id.toString())).toBe("expired");
            const session = await findSessionById(issued.sessionId);
            expect(session?.revokedAt).toBeInstanceOf(Date);
        });

        it("rejects an already-verified challenge and revokes the session (req 9)", async () => {
            const user = await createUser({ plainPassword: PASSWORD });
            const userId = user._id.toString();
            const issued = await issueRefreshTokenForSession({
                userId,
                state: "step_up_pending",
            });
            const challenge = await createVerifiedChallenge({ userId });

            await expect(
                completePasswordStepUpChallenge({
                    challengeId: challenge._id.toString(),
                    password: PASSWORD,
                    refreshToken: issued.refreshToken,
                })
            ).rejects.toThrow("Challenge is not pending");

            const session = await findSessionById(issued.sessionId);
            expect(session?.revokedAt).toBeInstanceOf(Date);
        });

        it("rejects when the session is missing (req 10)", async () => {
            // Mint a signature-valid token but never persist its session.
            const user = await createUser({ plainPassword: PASSWORD });
            const minted = mintRefreshToken({ userId: user._id.toString() });
            const challenge = await createPendingPasswordChallenge({
                userId: user._id.toString(),
            });

            await expect(
                completePasswordStepUpChallenge({
                    challengeId: challenge._id.toString(),
                    password: PASSWORD,
                    refreshToken: minted.refreshToken,
                })
            ).rejects.toThrow("Invalid session");
        });

        it("FINDING: a missing user throws 'User not found' but does NOT revoke the session (req 11)", async () => {
            const { issued, challengeId } = await setupStepUp({ createUserDoc: false });

            await expect(
                completePasswordStepUpChallenge({
                    challengeId,
                    password: PASSWORD,
                    refreshToken: issued.refreshToken,
                })
            ).rejects.toThrow("User not found");

            // Unlike the challenge-validation failures, the user-missing branch
            // leaves the session pending (no defensive revoke).
            const session = await findSessionById(issued.sessionId);
            expect(session?.state).toBe("step_up_pending");
            expect(session?.revokedAt).toBeNull();
        });
    });

    describe("security", () => {
        it("enforces single-use: a verified challenge cannot be replayed (req 12)", async () => {
            const { issued, challengeId } = await setupStepUp();

            await completePasswordStepUpChallenge({
                challengeId,
                password: PASSWORD,
                refreshToken: issued.refreshToken,
            });
            expect(await challengeStatus(challengeId)).toBe("verified");

            // Re-pend the (now active) session to isolate the challenge guard,
            // then replay the same challenge: it is no longer pending.
            await markSessionStepUpPending(issued.sessionId);

            await expect(
                completePasswordStepUpChallenge({
                    challengeId,
                    password: PASSWORD,
                    refreshToken: issued.refreshToken,
                })
            ).rejects.toThrow("Challenge is not pending");

            const session = await findSessionById(issued.sessionId);
            expect(session?.revokedAt).toBeInstanceOf(Date);
        });

        it("rejects a token-version mismatch and revokes the session, leaving the challenge pending (req 13)", async () => {
            const { issued, challengeId } = await setupStepUp({
                userTokenVersion: 5,
                sessionTokenVersion: 0,
            });

            await expect(
                completePasswordStepUpChallenge({
                    challengeId,
                    password: PASSWORD,
                    refreshToken: issued.refreshToken,
                })
            ).rejects.toThrow("Token version revoked");

            const session = await findSessionById(issued.sessionId);
            expect(session?.revokedAt).toBeInstanceOf(Date);
            // The version check runs before markChallengeVerified, so the
            // challenge is never consumed.
            expect(await challengeStatus(challengeId)).toBe("pending");
        });

        it("rejects a challenge belonging to a different user and revokes the session (req 14)", async () => {
            const owner = await createUser({ plainPassword: PASSWORD });
            const ownerId = owner._id.toString();
            const issued = await issueRefreshTokenForSession({
                userId: ownerId,
                state: "step_up_pending",
            });
            // Challenge created for a DIFFERENT user.
            const challenge = await createPendingPasswordChallenge({ userId: objectId() });

            await expect(
                completePasswordStepUpChallenge({
                    challengeId: challenge._id.toString(),
                    password: PASSWORD,
                    refreshToken: issued.refreshToken,
                })
            ).rejects.toThrow("Challenge user mismatch");

            const session = await findSessionById(issued.sessionId);
            expect(session?.revokedAt).toBeInstanceOf(Date);
        });

        it("FINDING: challenges are NOT bound to a session - any pending session of the same user can consume one (req 15)", async () => {
            const user = await createUser({ plainPassword: PASSWORD });
            const userId = user._id.toString();

            // Two distinct step_up_pending sessions for the same user.
            const sessionA = await issueRefreshTokenForSession({
                userId,
                state: "step_up_pending",
            });
            const sessionB = await issueRefreshTokenForSession({
                userId,
                state: "step_up_pending",
            });

            // A single challenge (conceptually raised for one session) ...
            const challenge = await createPendingPasswordChallenge({ userId });

            // ... is accepted when completed against the OTHER session, because
            // the service only checks challenge.userId === payload.sub.
            const result = await completePasswordStepUpChallenge({
                challengeId: challenge._id.toString(),
                password: PASSWORD,
                refreshToken: sessionB.refreshToken,
            });

            expect(result.sessionId).toBe(sessionB.sessionId);
            // Session B is now active; session A is untouched/still pending.
            expect((await findSessionById(sessionB.sessionId))?.state).toBe("active");
            expect((await findSessionById(sessionA.sessionId))?.state).toBe("step_up_pending");
        });

        it("revokes the session on an invalid (non-pending) challenge while preserving challenge state (req 16)", async () => {
            const user = await createUser({ plainPassword: PASSWORD });
            const userId = user._id.toString();
            const issued = await issueRefreshTokenForSession({
                userId,
                state: "step_up_pending",
            });
            const challenge = await createVerifiedChallenge({ userId });

            await expect(
                completePasswordStepUpChallenge({
                    challengeId: challenge._id.toString(),
                    password: PASSWORD,
                    refreshToken: issued.refreshToken,
                })
            ).rejects.toThrow("Challenge is not pending");

            // Defensive revoke fired; the challenge itself is left as-is (verified).
            const session = await findSessionById(issued.sessionId);
            expect(session?.revokedAt).toBeInstanceOf(Date);
            expect(await challengeStatus(challenge._id.toString())).toBe("verified");
        });
    });
});
