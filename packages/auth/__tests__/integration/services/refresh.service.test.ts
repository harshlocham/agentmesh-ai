import { describe, expect, it } from "vitest";
import { Types } from "mongoose";
import { refreshService } from "../../../services/refresh.service.js";
import { verifySession } from "../../../session/verify-session.js";
import { verifyAccessToken, verifyRefreshToken } from "../../../tokens/verify.js";
import { generateRefreshToken } from "../../../tokens/generate.js";
import { hashToken } from "../../../session/token-hash.js";
import { AuthStepUpRequiredError } from "../../../errors/auth-errors.js";
import {
    findSessionById,
    findSessionByIdWithToken,
} from "../../../repositories/session.repo.js";
import { SessionModel } from "../../../repositories/sessionModel.js";
import { StepUpChallenge } from "../../../../db/models/StepUpChallenge.js";
import { useTestDb } from "../../helpers/db.js";
import { objectId } from "../../helpers/ids.js";
import { createUser } from "../../helpers/factories/user.factory.js";
import { issueRefreshTokenForSession } from "../../helpers/factories/refresh-token.factory.js";
import {
    buildRequestContext,
    driftedContext,
    storedDeviceFingerprint,
    type RequestContext,
} from "../../helpers/factories/request-context.factory.js";
import { decodeJwt } from "../../helpers/assertions/token-assertions.js";

useTestDb();

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// The refresh token's identity-defining payload is unchanged by rotation; the
// signer is deterministic over (payload, iat-second). So a genuinely different
// token only appears once the wall clock crosses a 1-second boundary. Tests that
// need a REAL rotation wait this long before refreshing.
const ROTATION_DELAY_MS = 1200;

interface RefreshableSetup {
    ctx: RequestContext;
    userId: string;
    issued: Awaited<ReturnType<typeof issueRefreshTokenForSession>>;
}

/**
 * Create a real user + a fingerprint-matching, signature-valid session whose
 * refresh token will pass verifySession and the fingerprint check.
 */
async function setupRefreshable(opts: {
    ctx?: Partial<RequestContext>;
    userTokenVersion?: number;
    sessionTokenVersion?: number;
    role?: "user" | "moderator" | "admin";
    status?: "active" | "banned";
    isDeleted?: boolean;
    createUserDoc?: boolean;
} = {}): Promise<RefreshableSetup> {
    const ctx = buildRequestContext(opts.ctx);
    const userTokenVersion = opts.userTokenVersion ?? 0;
    const sessionTokenVersion = opts.sessionTokenVersion ?? userTokenVersion;

    let userId: string;
    if (opts.createUserDoc === false) {
        userId = objectId();
    } else {
        const user = await createUser({
            tokenVersion: userTokenVersion,
            role: opts.role ?? "user",
            status: opts.status ?? "active",
            isDeleted: opts.isDeleted ?? false,
        });
        userId = user._id.toString();
    }

    const issued = await issueRefreshTokenForSession({
        userId,
        tokenVersion: sessionTokenVersion,
        deviceId: storedDeviceFingerprint(ctx),
        userAgent: ctx.userAgent,
        ipAddress: ctx.ipAddress,
    });

    return { ctx, userId, issued };
}

describe("services/refresh.service (db integration)", () => {
    describe("happy path", () => {
        it("issues a fresh, valid access token (req 1)", async () => {
            const { ctx, userId, issued } = await setupRefreshable({
                role: "admin",
                userTokenVersion: 3,
                sessionTokenVersion: 3,
            });

            const result = await refreshService({ refreshToken: issued.refreshToken, ...ctx });

            const accessPayload = verifyAccessToken(result.accessToken);
            expect(accessPayload.sub).toBe(userId);
            expect(accessPayload.type).toBe("access");
            expect(result.userId).toBe(userId);
            expect(result.sessionId).toBe(issued.sessionId);
        });

        it("rotates the refresh token to a new value once a second has elapsed (req 2)", async () => {
            const { ctx, issued } = await setupRefreshable();

            await sleep(ROTATION_DELAY_MS);
            const result = await refreshService({ refreshToken: issued.refreshToken, ...ctx });

            expect(result.refreshToken).not.toBe(issued.refreshToken);
            // The new token is itself a valid refresh token bound to the same session.
            const newPayload = verifyRefreshToken(result.refreshToken);
            expect(newPayload.sessionId).toBe(issued.sessionId);
        });

        it("makes the old refresh token unusable after rotation (req 3)", async () => {
            const { ctx, issued } = await setupRefreshable();

            await sleep(ROTATION_DELAY_MS);
            await refreshService({ refreshToken: issued.refreshToken, ...ctx });

            // The stored hash now matches the NEW token, so the old one fails verify.
            await expect(verifySession(issued.refreshToken)).rejects.toThrow(
                "Invalid session token"
            );
        });

        it("the new refresh token works for a subsequent refresh (req 4)", async () => {
            const { ctx, issued } = await setupRefreshable();

            await sleep(ROTATION_DELAY_MS);
            const first = await refreshService({ refreshToken: issued.refreshToken, ...ctx });

            // The newly issued token verifies and can drive another refresh.
            const { payload } = await verifySession(first.refreshToken);
            expect(payload.sessionId).toBe(issued.sessionId);

            const second = await refreshService({ refreshToken: first.refreshToken, ...ctx });
            expect(second.accessToken).toBeTruthy();
            expect(second.refreshToken).toBeTruthy();
        });

        it("keeps the session active after a refresh (req 5)", async () => {
            const { ctx, issued } = await setupRefreshable();

            await refreshService({ refreshToken: issued.refreshToken, ...ctx });

            const session = await findSessionById(issued.sessionId);
            expect(session).not.toBeNull();
            expect(session?.state).toBe("active");
            expect(session?.revokedAt).toBeNull();
        });
    });

    describe("user state", () => {
        it("rejects when the user no longer exists (req 6)", async () => {
            const { ctx, issued } = await setupRefreshable({ createUserDoc: false });

            await expect(
                refreshService({ refreshToken: issued.refreshToken, ...ctx })
            ).rejects.toThrow("User not found");
        });

        it("rejects when the user account is inactive/banned (req 7)", async () => {
            const { ctx, issued } = await setupRefreshable({ status: "banned" });

            await expect(
                refreshService({ refreshToken: issued.refreshToken, ...ctx })
            ).rejects.toThrow("Account is not active");
        });

        it("FINDING: a soft-deleted user (isDeleted=true, status=active) can still refresh (req 8)", async () => {
            const { ctx, issued, userId } = await setupRefreshable({ isDeleted: true });

            // refreshService only checks `status`, never `isDeleted`, so a
            // soft-deleted account is still granted fresh tokens.
            const result = await refreshService({ refreshToken: issued.refreshToken, ...ctx });

            expect(result.userId).toBe(userId);
            expect(verifyAccessToken(result.accessToken).sub).toBe(userId);
        });
    });

    describe("token version", () => {
        it("rejects refresh when the token version is stale (req 9)", async () => {
            const { ctx, issued } = await setupRefreshable({
                userTokenVersion: 5,
                sessionTokenVersion: 0,
            });

            await expect(
                refreshService({ refreshToken: issued.refreshToken, ...ctx })
            ).rejects.toThrow("Token version revoked");
        });

        it("revokes the session on a token version mismatch (req 10)", async () => {
            const { ctx, issued } = await setupRefreshable({
                userTokenVersion: 5,
                sessionTokenVersion: 0,
            });

            await refreshService({ refreshToken: issued.refreshToken, ...ctx }).catch(() => {});

            const session = await findSessionById(issued.sessionId);
            expect(session?.revokedAt).toBeInstanceOf(Date);
        });
    });

    describe("replay protection", () => {
        it("rejects reuse of a rotated refresh token (req 11)", async () => {
            const { ctx, issued } = await setupRefreshable();

            await sleep(ROTATION_DELAY_MS);
            await refreshService({ refreshToken: issued.refreshToken, ...ctx });

            await expect(
                refreshService({ refreshToken: issued.refreshToken, ...ctx })
            ).rejects.toThrow("Invalid session token");
        });

        it("updates the persisted session hash to match the new token (req 12)", async () => {
            const { ctx, issued } = await setupRefreshable();
            const originalHash = issued.refreshTokenHash;

            await sleep(ROTATION_DELAY_MS);
            const result = await refreshService({ refreshToken: issued.refreshToken, ...ctx });

            const stored = await findSessionByIdWithToken(issued.sessionId);
            expect(stored?.refreshTokenHash).not.toBe(originalHash);
            expect(stored?.refreshTokenHash).toBe(hashToken(result.refreshToken));
        });
    });

    describe("fingerprint validation", () => {
        it("succeeds when the device fingerprint matches (req 13)", async () => {
            const { ctx, issued } = await setupRefreshable();

            const result = await refreshService({ refreshToken: issued.refreshToken, ...ctx });

            expect(result.accessToken).toBeTruthy();
            expect(result.refreshToken).toBeTruthy();
        });

        it("throws AuthStepUpRequiredError on device fingerprint drift (req 14)", async () => {
            const { ctx, issued } = await setupRefreshable();
            const drifted = driftedContext(ctx);

            const error = await refreshService({
                refreshToken: issued.refreshToken,
                ...drifted,
            }).catch((e: unknown) => e);

            expect(error).toBeInstanceOf(AuthStepUpRequiredError);
            expect((error as AuthStepUpRequiredError).reasons).toContain("device_mismatch");
            expect((error as AuthStepUpRequiredError).challengeId).toBeTruthy();
        });

        it("transitions the session into step_up_pending on drift (req 15)", async () => {
            const { ctx, issued } = await setupRefreshable();

            await refreshService({
                refreshToken: issued.refreshToken,
                ...driftedContext(ctx),
            }).catch(() => {});

            const session = await findSessionById(issued.sessionId);
            expect(session?.state).toBe("step_up_pending");
        });

        it("creates a pending step-up challenge record on drift (req 16)", async () => {
            const { ctx, issued, userId } = await setupRefreshable();

            const error = (await refreshService({
                refreshToken: issued.refreshToken,
                ...driftedContext(ctx),
            }).catch((e: unknown) => e)) as AuthStepUpRequiredError;

            const challenge = await StepUpChallenge.findById(error.challengeId);
            expect(challenge).not.toBeNull();
            expect(challenge?.status).toBe("pending");
            expect(String(challenge?.userId)).toBe(userId);
            expect(
                await StepUpChallenge.countDocuments({
                    userId: new Types.ObjectId(userId),
                })
            ).toBe(1);
        });

        it("does NOT delete or revoke the session during step-up (req 17)", async () => {
            const { ctx, issued } = await setupRefreshable();

            await refreshService({
                refreshToken: issued.refreshToken,
                ...driftedContext(ctx),
            }).catch(() => {});

            const session = await findSessionById(issued.sessionId);
            expect(session).not.toBeNull();
            expect(session?.revokedAt).toBeNull();
            // The original refresh token still verifies, so step-up completion can
            // re-use this session.
            const { payload } = await verifySession(issued.refreshToken);
            expect(payload.sessionId).toBe(issued.sessionId);
        });
    });

    describe("security", () => {
        it("returns tokens carrying the user's current role and tokenVersion (req 18)", async () => {
            const { ctx, userId, issued } = await setupRefreshable({
                role: "moderator",
                userTokenVersion: 4,
                sessionTokenVersion: 4,
            });

            const result = await refreshService({ refreshToken: issued.refreshToken, ...ctx });

            const accessPayload = verifyAccessToken(result.accessToken);
            expect(accessPayload.sub).toBe(userId);
            expect(accessPayload.role).toBe("moderator");
            expect(accessPayload.tokenVersion).toBe(4);

            const refreshPayload = verifyRefreshToken(result.refreshToken);
            expect(refreshPayload.sub).toBe(userId);
            expect(refreshPayload.tokenVersion).toBe(4);
            expect(refreshPayload.sessionId).toBe(issued.sessionId);
        });

        it("cannot replay the old refresh token after a successful rotation (req 19)", async () => {
            const { ctx, issued } = await setupRefreshable();

            await sleep(ROTATION_DELAY_MS);
            const rotated = await refreshService({ refreshToken: issued.refreshToken, ...ctx });

            // Old token is dead; only the rotated token is accepted.
            await expect(
                refreshService({ refreshToken: issued.refreshToken, ...ctx })
            ).rejects.toThrow("Invalid session token");
            const { payload } = await verifySession(rotated.refreshToken);
            expect(payload.sessionId).toBe(issued.sessionId);
        });

        it("never persists the plaintext refresh token (req 20)", async () => {
            const { ctx, issued } = await setupRefreshable();

            const result = await refreshService({ refreshToken: issued.refreshToken, ...ctx });

            const stored = await findSessionByIdWithToken(issued.sessionId);
            // Only a sha-256 hex digest is stored, never the JWT itself.
            expect(stored?.refreshTokenHash).toMatch(/^[a-f0-9]{64}$/);
            expect(stored?.refreshTokenHash).not.toBe(result.refreshToken);
            expect(stored?.refreshTokenHash).not.toBe(issued.refreshToken);
            expect(stored?.refreshTokenHash).toBe(hashToken(result.refreshToken));

            // The hash is hidden on ordinary reads (select:false).
            const normal = await findSessionById(issued.sessionId);
            expect(normal?.refreshTokenHash).toBeUndefined();
        });
    });

    describe("findings", () => {
        it("FINDING: rotation keeps the same payload, so a same-second refresh returns an IDENTICAL token (no real rotation)", async () => {
            const { ctx, issued } = await setupRefreshable();

            // Refresh immediately (same wall-clock second as token issuance).
            const result = await refreshService({ refreshToken: issued.refreshToken, ...ctx });

            const before = decodeJwt<{ sub: string; sessionId: string; tokenVersion: number; type: string }>(
                issued.refreshToken
            );
            const after = decodeJwt<{ sub: string; sessionId: string; tokenVersion: number; type: string }>(
                result.refreshToken
            );

            // The identity-defining claims are byte-identical across "rotation".
            expect({
                sub: after.sub,
                sessionId: after.sessionId,
                tokenVersion: after.tokenVersion,
                type: after.type,
            }).toEqual({
                sub: before.sub,
                sessionId: before.sessionId,
                tokenVersion: before.tokenVersion,
                type: before.type,
            });

            // Root cause, demonstrated deterministically with the REAL signer:
            // identical payload signed within the same iat-second yields the exact
            // same JWT string. Loop guarantees a same-second pair (back-to-back).
            const payload = {
                sub: before.sub,
                sessionId: before.sessionId,
                tokenVersion: before.tokenVersion,
                type: "refresh" as const,
            };
            let a = generateRefreshToken(payload);
            let b = generateRefreshToken(payload);
            for (let i = 0; i < 1000 && decodeJwt<{ iat: number }>(a).iat !== decodeJwt<{ iat: number }>(b).iat; i++) {
                a = generateRefreshToken(payload);
                b = generateRefreshToken(payload);
            }
            expect(decodeJwt<{ iat: number }>(a).iat).toBe(decodeJwt<{ iat: number }>(b).iat);
            expect(a).toBe(b);
        });

        it("FINDING: fingerprint/step-up runs before user checks, so a banned user's drift still creates a challenge", async () => {
            const { ctx, issued, userId } = await setupRefreshable({ status: "banned" });

            const error = await refreshService({
                refreshToken: issued.refreshToken,
                ...driftedContext(ctx),
            }).catch((e: unknown) => e);

            // The account is banned, yet a step-up challenge + session mutation
            // happen before the status check is ever reached.
            expect(error).toBeInstanceOf(AuthStepUpRequiredError);
            expect(
                await StepUpChallenge.countDocuments({
                    userId: new Types.ObjectId(userId),
                })
            ).toBe(1);
            const session = await SessionModel.findById(issued.sessionId);
            expect(session?.state).toBe("step_up_pending");
        });
    });
});
