import { describe, expect, it } from "vitest";
import {
    requestOtpStepUpChallenge,
    completeOtpStepUpChallenge,
} from "../../../services/step-up-otp.service.js";
import { verifyAccessToken, verifyRefreshToken } from "../../../tokens/verify.js";
import { comparePassword } from "../../../password/compare.js";
import { hashPassword } from "../../../password/hash.js";
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

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const ROTATION_DELAY_MS = 1200;

interface OtpSetup {
    userId: string;
    email: string;
    issued: Awaited<ReturnType<typeof issueRefreshTokenForSession>>;
    challengeId: string;
}

async function setupOtp(opts: {
    userTokenVersion?: number;
    sessionTokenVersion?: number;
    role?: "user" | "moderator" | "admin";
    status?: "active" | "banned";
    createUserDoc?: boolean;
    challengeUserId?: string;
} = {}): Promise<OtpSetup> {
    const userTokenVersion = opts.userTokenVersion ?? 0;
    const sessionTokenVersion = opts.sessionTokenVersion ?? userTokenVersion;

    let userId: string;
    let email = "";
    if (opts.createUserDoc === false) {
        userId = objectId();
    } else {
        const user = await createUser({
            tokenVersion: userTokenVersion,
            role: opts.role ?? "user",
            status: opts.status ?? "active",
        });
        userId = user._id.toString();
        email = user.email;
    }

    const issued = await issueRefreshTokenForSession({
        userId,
        tokenVersion: sessionTokenVersion,
        state: "step_up_pending",
    });

    const challenge = await createPendingPasswordChallenge({
        userId: opts.challengeUserId ?? userId,
    });

    return { userId, email, issued, challengeId: challenge._id.toString() };
}

async function readChallenge(challengeId: string) {
    return StepUpChallenge.findById(challengeId).lean<{
        status?: string;
        verificationMethod?: string;
        otp?: { hash?: string; sentAt?: Date };
    } | null>();
}

describe("services/step-up-otp.service (db integration)", () => {
    describe("requestOtpStepUpChallenge - happy path", () => {
        it("generates a 6-digit OTP and returns delivery details (req: OTP generation)", async () => {
            const { userId, email, issued, challengeId } = await setupOtp();

            const result = await requestOtpStepUpChallenge({
                challengeId,
                refreshToken: issued.refreshToken,
            });

            expect(result.challengeId).toBe(challengeId);
            expect(result.userId).toBe(userId);
            expect(result.email).toBe(email);
            expect(result.otp).toMatch(/^\d{6}$/);
            expect(result.expiresAt).toBeInstanceOf(Date);
        });

        it("persists only a bcrypt OTP hash (never the plaintext) and switches method to otp", async () => {
            const { issued, challengeId } = await setupOtp();

            const { otp } = await requestOtpStepUpChallenge({
                challengeId,
                refreshToken: issued.refreshToken,
            });

            const challenge = await readChallenge(challengeId);
            expect(challenge?.verificationMethod).toBe("otp");
            expect(challenge?.otp?.hash).toMatch(/^\$2[aby]\$/);
            expect(challenge?.otp?.hash).not.toBe(otp);
            // The stored hash genuinely verifies against the issued code.
            expect(await comparePassword(otp, challenge!.otp!.hash!)).toBe(true);
            expect(challenge?.otp?.sentAt).toBeInstanceOf(Date);
        });

        it("does not revoke or activate the session on request (stays pending)", async () => {
            const { issued, challengeId } = await setupOtp();

            await requestOtpStepUpChallenge({ challengeId, refreshToken: issued.refreshToken });

            const session = await findSessionById(issued.sessionId);
            expect(session?.state).toBe("step_up_pending");
            expect(session?.revokedAt).toBeNull();
        });
    });

    describe("completeOtpStepUpChallenge - happy path", () => {
        it("verifies the OTP and completes the challenge end-to-end (req: OTP verification, completion)", async () => {
            const { userId, issued, challengeId } = await setupOtp();
            const { otp } = await requestOtpStepUpChallenge({
                challengeId,
                refreshToken: issued.refreshToken,
            });

            const result = await completeOtpStepUpChallenge({
                challengeId,
                otp,
                refreshToken: issued.refreshToken,
            });

            expect(result.userId).toBe(userId);
            expect(result.sessionId).toBe(issued.sessionId);
            expect(result.challengeId).toBe(challengeId);

            // Challenge marked verified and the OTP hash scrubbed.
            const challenge = await readChallenge(challengeId);
            expect(challenge?.status).toBe("verified");
            expect(challenge?.otp?.hash).toBeUndefined();
        });

        it("restores the session to active (req: session restoration)", async () => {
            const { issued, challengeId } = await setupOtp();
            const { otp } = await requestOtpStepUpChallenge({
                challengeId,
                refreshToken: issued.refreshToken,
            });

            await completeOtpStepUpChallenge({ challengeId, otp, refreshToken: issued.refreshToken });

            const session = await findSessionById(issued.sessionId);
            expect(session?.state).toBe("active");
            expect(session?.revokedAt).toBeNull();
        });

        it("rotates the refresh token and updates the stored hash (req: token rotation)", async () => {
            const { issued, challengeId } = await setupOtp();
            const { otp } = await requestOtpStepUpChallenge({
                challengeId,
                refreshToken: issued.refreshToken,
            });

            await sleep(ROTATION_DELAY_MS);
            const result = await completeOtpStepUpChallenge({
                challengeId,
                otp,
                refreshToken: issued.refreshToken,
            });

            expect(result.refreshToken).not.toBe(issued.refreshToken);
            expect(verifyRefreshToken(result.refreshToken).sessionId).toBe(issued.sessionId);
            const stored = await findSessionByIdWithToken(issued.sessionId);
            expect(stored?.refreshTokenHash).toBe(hashToken(result.refreshToken));
        });

        it("issues an access token with role and tokenVersion claims (req: access token issuance)", async () => {
            const { userId, issued, challengeId } = await setupOtp({
                role: "admin",
                userTokenVersion: 7,
                sessionTokenVersion: 7,
            });
            const { otp } = await requestOtpStepUpChallenge({
                challengeId,
                refreshToken: issued.refreshToken,
            });

            const result = await completeOtpStepUpChallenge({
                challengeId,
                otp,
                refreshToken: issued.refreshToken,
            });

            const access = verifyAccessToken(result.accessToken);
            expect(access.sub).toBe(userId);
            expect(access.role).toBe("admin");
            expect(access.tokenVersion).toBe(7);
        });
    });

    describe("failure", () => {
        it("revokes the session when the challenge is missing (request)", async () => {
            const { issued } = await setupOtp();
            await expect(
                requestOtpStepUpChallenge({ challengeId: objectId(), refreshToken: issued.refreshToken })
            ).rejects.toThrow("Challenge not found");
            expect((await findSessionById(issued.sessionId))?.revokedAt).toBeInstanceOf(Date);
        });

        it("revokes the session when the challenge is missing (complete)", async () => {
            const { issued } = await setupOtp();
            await expect(
                completeOtpStepUpChallenge({
                    challengeId: objectId(),
                    otp: "123456",
                    refreshToken: issued.refreshToken,
                })
            ).rejects.toThrow("Challenge not found");
            expect((await findSessionById(issued.sessionId))?.revokedAt).toBeInstanceOf(Date);
        });

        it("FINDING: an expired challenge reports 'Challenge is not pending' (dead 'Challenge expired' branch)", async () => {
            const user = await createUser();
            const issued = await issueRefreshTokenForSession({
                userId: user._id.toString(),
                state: "step_up_pending",
            });
            const challenge = await createExpiredChallenge({ userId: user._id.toString() });

            await expect(
                completeOtpStepUpChallenge({
                    challengeId: challenge._id.toString(),
                    otp: "123456",
                    refreshToken: issued.refreshToken,
                })
            ).rejects.toThrow("Challenge is not pending");
            expect((await findSessionById(issued.sessionId))?.revokedAt).toBeInstanceOf(Date);
        });

        it("rejects an already-verified challenge and revokes the session", async () => {
            const user = await createUser();
            const issued = await issueRefreshTokenForSession({
                userId: user._id.toString(),
                state: "step_up_pending",
            });
            const challenge = await createVerifiedChallenge({ userId: user._id.toString() });

            await expect(
                completeOtpStepUpChallenge({
                    challengeId: challenge._id.toString(),
                    otp: "123456",
                    refreshToken: issued.refreshToken,
                })
            ).rejects.toThrow("Challenge is not pending");
            expect((await findSessionById(issued.sessionId))?.revokedAt).toBeInstanceOf(Date);
        });

        it("rejects when the session is missing", async () => {
            const user = await createUser();
            const minted = mintRefreshToken({ userId: user._id.toString() });
            const challenge = await createPendingPasswordChallenge({ userId: user._id.toString() });

            await expect(
                requestOtpStepUpChallenge({
                    challengeId: challenge._id.toString(),
                    refreshToken: minted.refreshToken,
                })
            ).rejects.toThrow("Invalid session");
        });

        it("FINDING: a missing user throws 'User not found' WITHOUT revoking the session", async () => {
            const { issued, challengeId } = await setupOtp({ createUserDoc: false });
            await expect(
                requestOtpStepUpChallenge({ challengeId, refreshToken: issued.refreshToken })
            ).rejects.toThrow("User not found");

            const session = await findSessionById(issued.sessionId);
            expect(session?.state).toBe("step_up_pending");
            expect(session?.revokedAt).toBeNull();
        });

        it("rejects a wrong OTP WITHOUT revoking the session (retryable)", async () => {
            const { issued, challengeId } = await setupOtp();
            const { otp } = await requestOtpStepUpChallenge({
                challengeId,
                refreshToken: issued.refreshToken,
            });
            const wrongOtp = otp === "000000" ? "111111" : "000000";

            await expect(
                completeOtpStepUpChallenge({
                    challengeId,
                    otp: wrongOtp,
                    refreshToken: issued.refreshToken,
                })
            ).rejects.toThrow("Invalid OTP");

            const session = await findSessionById(issued.sessionId);
            expect(session?.state).toBe("step_up_pending");
            expect(session?.revokedAt).toBeNull();
            // Challenge stays pending with its OTP intact, so the user can retry.
            const challenge = await readChallenge(challengeId);
            expect(challenge?.status).toBe("pending");
            expect(challenge?.otp?.hash).toBeTruthy();
        });

        it("rejects completion when the OTP was never requested", async () => {
            const { issued, challengeId } = await setupOtp();

            await expect(
                completeOtpStepUpChallenge({
                    challengeId,
                    otp: "123456",
                    refreshToken: issued.refreshToken,
                })
            ).rejects.toThrow("OTP has not been requested");

            // No OTP requested -> session remains pending (no revoke).
            expect((await findSessionById(issued.sessionId))?.revokedAt).toBeNull();
        });

        it("enforces the resend cooldown without revoking the session", async () => {
            const { issued, challengeId } = await setupOtp();
            await requestOtpStepUpChallenge({ challengeId, refreshToken: issued.refreshToken });

            await expect(
                requestOtpStepUpChallenge({ challengeId, refreshToken: issued.refreshToken })
            ).rejects.toThrow("Please wait before requesting another OTP");

            expect((await findSessionById(issued.sessionId))?.revokedAt).toBeNull();
        });
    });

    describe("security", () => {
        it("enforces single-use: a completed OTP/challenge cannot be replayed", async () => {
            const { issued, challengeId } = await setupOtp();
            const { otp } = await requestOtpStepUpChallenge({
                challengeId,
                refreshToken: issued.refreshToken,
            });
            const first = await completeOtpStepUpChallenge({
                challengeId,
                otp,
                refreshToken: issued.refreshToken,
            });
            expect((await readChallenge(challengeId))?.status).toBe("verified");

            // Re-pend the (now active) session and replay using the rotated token
            // to isolate the challenge single-use guard: the challenge is consumed.
            await markSessionStepUpPending(issued.sessionId);
            await expect(
                completeOtpStepUpChallenge({
                    challengeId,
                    otp,
                    refreshToken: first.refreshToken,
                })
            ).rejects.toThrow("Challenge is not pending");
            expect((await findSessionById(issued.sessionId))?.revokedAt).toBeInstanceOf(Date);
        });

        it("scrubs the OTP hash from storage after successful verification", async () => {
            const { issued, challengeId } = await setupOtp();
            const { otp } = await requestOtpStepUpChallenge({
                challengeId,
                refreshToken: issued.refreshToken,
            });

            const before = await readChallenge(challengeId);
            expect(before?.otp?.hash).toBeTruthy();

            await completeOtpStepUpChallenge({ challengeId, otp, refreshToken: issued.refreshToken });

            const after = await readChallenge(challengeId);
            expect(after?.otp?.hash).toBeUndefined();
        });

        it("rejects a token-version mismatch and revokes the session (challenge stays pending)", async () => {
            const { issued, challengeId } = await setupOtp({
                userTokenVersion: 5,
                sessionTokenVersion: 0,
            });
            // Seed a valid OTP hash directly so we reach the post-OTP version check.
            const knownOtp = "654321";
            await StepUpChallenge.findByIdAndUpdate(challengeId, {
                $set: {
                    verificationMethod: "otp",
                    otp: { hash: await hashPassword(knownOtp), sentAt: new Date() },
                },
            });

            await expect(
                completeOtpStepUpChallenge({
                    challengeId,
                    otp: knownOtp,
                    refreshToken: issued.refreshToken,
                })
            ).rejects.toThrow("Token version revoked");

            expect((await findSessionById(issued.sessionId))?.revokedAt).toBeInstanceOf(Date);
            expect((await readChallenge(challengeId))?.status).toBe("pending");
        });

        it("rejects a challenge owned by a different user and revokes the session", async () => {
            const owner = await createUser();
            const issued = await issueRefreshTokenForSession({
                userId: owner._id.toString(),
                state: "step_up_pending",
            });
            const challenge = await createPendingPasswordChallenge({ userId: objectId() });

            await expect(
                completeOtpStepUpChallenge({
                    challengeId: challenge._id.toString(),
                    otp: "123456",
                    refreshToken: issued.refreshToken,
                })
            ).rejects.toThrow("Challenge user mismatch");
            expect((await findSessionById(issued.sessionId))?.revokedAt).toBeInstanceOf(Date);
        });

        it("FINDING: OTP challenges are not bound to a session - another pending session can consume them", async () => {
            const user = await createUser();
            const userId = user._id.toString();
            const sessionA = await issueRefreshTokenForSession({ userId, state: "step_up_pending" });
            const sessionB = await issueRefreshTokenForSession({ userId, state: "step_up_pending" });
            const challenge = await createPendingPasswordChallenge({ userId });
            const challengeId = challenge._id.toString();

            // Request OTP against session A...
            const { otp } = await requestOtpStepUpChallenge({
                challengeId,
                refreshToken: sessionA.refreshToken,
            });

            // ...then complete it against session B.
            const result = await completeOtpStepUpChallenge({
                challengeId,
                otp,
                refreshToken: sessionB.refreshToken,
            });

            expect(result.sessionId).toBe(sessionB.sessionId);
            expect((await findSessionById(sessionB.sessionId))?.state).toBe("active");
            expect((await findSessionById(sessionA.sessionId))?.state).toBe("step_up_pending");
        });
    });
});
