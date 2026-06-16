import { describe, expect, it } from "vitest";
import {
    createSession,
    deleteSession,
    deleteUserSessions,
    findSessionById,
    findSessionByIdWithToken,
    markSessionStepUpPending,
    revokeSession,
    rotateSessionTokenHash,
} from "../../../repositories/session.repo.js";
import { authConfig } from "../../../config.js";
import { hashToken } from "../../../session/token-hash.js";
import { useTestDb } from "../../helpers/db.js";
import { objectId } from "../../helpers/ids.js";
import { createUser } from "../../helpers/factories/user.factory.js";
import { createSessionDoc } from "../../helpers/factories/session.factory.js";
import { issueRefreshTokenForSession } from "../../helpers/factories/refresh-token.factory.js";

useTestDb();

describe("repositories/session.repo (db integration)", () => {
    describe("createSession", () => {
        it("persists a session with the provided fields and a derived _id", async () => {
            const user = await createUser();
            const userId = user._id.toString();
            const sessionId = objectId();
            const refreshTokenHash = hashToken("create-token");

            const before = Date.now();
            const session = await createSession({
                sessionId,
                userId,
                refreshTokenHash,
                deviceId: "device-fingerprint",
                userAgent: "Mozilla/5.0",
                ipAddress: "203.0.113.7",
            });
            const after = Date.now();

            expect(session._id.toString()).toBe(sessionId);
            expect(String(session.userId)).toBe(userId);
            expect(session.deviceId).toBe("device-fingerprint");
            expect(session.userAgent).toBe("Mozilla/5.0");
            expect(session.ipAddress).toBe("203.0.113.7");
            expect(session.state).toBe("active");
            expect(session.revokedAt).toBeNull();
            expect(session.lastActiveAt).toBeInstanceOf(Date);

            // expiresAt is set to now + configured refresh TTL.
            const ttl = authConfig.session.refreshTtlMs;
            expect(session.expiresAt.getTime()).toBeGreaterThanOrEqual(before + ttl - 1000);
            expect(session.expiresAt.getTime()).toBeLessThanOrEqual(after + ttl + 1000);

            // The hash is persisted (read back with the privileged select).
            const stored = await findSessionByIdWithToken(sessionId);
            expect(stored?.refreshTokenHash).toBe(refreshTokenHash);
        });

        it("defaults userAgent and ipAddress to 'Unknown' when omitted", async () => {
            const user = await createUser();
            const session = await createSession({
                userId: user._id.toString(),
                refreshTokenHash: hashToken("defaults-token"),
                deviceId: "device-fingerprint",
            });

            expect(session.userAgent).toBe("Unknown");
            expect(session.ipAddress).toBe("Unknown");
        });

        it("generates an _id when sessionId is not supplied", async () => {
            const user = await createUser();
            const session = await createSession({
                userId: user._id.toString(),
                refreshTokenHash: hashToken("auto-id-token"),
                deviceId: "device-fingerprint",
            });

            expect(session._id).toBeDefined();
            const found = await findSessionById(session._id.toString());
            expect(found).not.toBeNull();
        });
    });

    describe("findSessionById", () => {
        it("returns the persisted session by id", async () => {
            const created = await createSessionDoc();
            const found = await findSessionById(created._id.toString());

            expect(found).not.toBeNull();
            expect(found?._id.toString()).toBe(created._id.toString());
        });

        it("returns null for a non-existent id", async () => {
            expect(await findSessionById(objectId())).toBeNull();
        });
    });

    describe("findSessionByIdWithToken", () => {
        it("includes the refreshTokenHash via the privileged select", async () => {
            const issued = await issueRefreshTokenForSession();

            const withToken = await findSessionByIdWithToken(issued.sessionId);
            expect(withToken?.refreshTokenHash).toBe(issued.refreshTokenHash);
        });
    });

    describe("rotateSessionTokenHash", () => {
        it("replaces the stored hash and extends expiry", async () => {
            const issued = await issueRefreshTokenForSession({
                expiresAt: new Date(Date.now() + 1000),
            });
            const originalExpiry = issued.session.expiresAt.getTime();
            const newHash = hashToken("rotated-token");

            const rotated = await rotateSessionTokenHash(issued.sessionId, newHash);
            expect(rotated).not.toBeNull();

            const stored = await findSessionByIdWithToken(issued.sessionId);
            expect(stored?.refreshTokenHash).toBe(newHash);
            // Expiry was pushed out to ~now + full TTL, well beyond the 1s original.
            expect(stored!.expiresAt.getTime()).toBeGreaterThan(originalExpiry);
        });

        it("returns null when the session does not exist", async () => {
            expect(await rotateSessionTokenHash(objectId(), hashToken("x"))).toBeNull();
        });

        it("does NOT clear revokedAt when rotating (revoked sessions stay revoked)", async () => {
            // Documents a latent behavior: rotation reactivates state but leaves
            // revokedAt intact, so a revoked session is not silently resurrected.
            const issued = await issueRefreshTokenForSession({ revokedAt: new Date() });

            await rotateSessionTokenHash(issued.sessionId, hashToken("rotated"));

            const stored = await findSessionById(issued.sessionId);
            expect(stored?.revokedAt).not.toBeNull();
            expect(stored?.state).toBe("active");
        });
    });

    describe("revokeSession", () => {
        it("sets revokedAt on the session", async () => {
            const issued = await issueRefreshTokenForSession();
            expect(issued.session.revokedAt).toBeNull();

            const revoked = await revokeSession(issued.sessionId);
            expect(revoked?.revokedAt).toBeInstanceOf(Date);

            const stored = await findSessionById(issued.sessionId);
            expect(stored?.revokedAt).toBeInstanceOf(Date);
        });

        it("returns null when the session does not exist", async () => {
            expect(await revokeSession(objectId())).toBeNull();
        });
    });

    describe("deleteSession", () => {
        it("removes the session document", async () => {
            const issued = await issueRefreshTokenForSession();

            const deleted = await deleteSession(issued.sessionId);
            expect(deleted?._id.toString()).toBe(issued.sessionId);
            expect(await findSessionById(issued.sessionId)).toBeNull();
        });

        it("returns null when the session does not exist", async () => {
            expect(await deleteSession(objectId())).toBeNull();
        });
    });

    describe("deleteUserSessions", () => {
        it("deletes only the target user's sessions", async () => {
            const userA = (await createUser())._id.toString();
            const userB = (await createUser())._id.toString();

            await issueRefreshTokenForSession({ userId: userA });
            await issueRefreshTokenForSession({ userId: userA });
            const sessionB = await issueRefreshTokenForSession({ userId: userB });

            const result = await deleteUserSessions(userA);
            expect(result.deletedCount).toBe(2);

            // User B's session is untouched.
            expect(await findSessionById(sessionB.sessionId)).not.toBeNull();
        });

        it("returns deletedCount 0 when the user has no sessions", async () => {
            const result = await deleteUserSessions(objectId());
            expect(result.deletedCount).toBe(0);
        });
    });

    describe("markSessionStepUpPending", () => {
        it("transitions the session into step_up_pending", async () => {
            const issued = await issueRefreshTokenForSession();
            expect(issued.session.state).toBe("active");

            const updated = await markSessionStepUpPending(issued.sessionId);
            expect(updated?.state).toBe("step_up_pending");

            const stored = await findSessionById(issued.sessionId);
            expect(stored?.state).toBe("step_up_pending");
        });

        it("returns null when the session does not exist", async () => {
            expect(await markSessionStepUpPending(objectId())).toBeNull();
        });
    });

    describe("state transition: rotate resets step_up_pending", () => {
        it("returns a step_up_pending session to active on rotation", async () => {
            const issued = await issueRefreshTokenForSession();
            await markSessionStepUpPending(issued.sessionId);

            const pending = await findSessionById(issued.sessionId);
            expect(pending?.state).toBe("step_up_pending");

            await rotateSessionTokenHash(issued.sessionId, hashToken("post-stepup-token"));

            const stored = await findSessionById(issued.sessionId);
            expect(stored?.state).toBe("active");
        });
    });

    describe("refreshTokenHash select:false", () => {
        it("hides refreshTokenHash on normal reads but exposes it via the privileged select", async () => {
            const issued = await issueRefreshTokenForSession();

            const normal = await findSessionById(issued.sessionId);
            expect(normal?.refreshTokenHash).toBeUndefined();

            const privileged = await findSessionByIdWithToken(issued.sessionId);
            expect(privileged?.refreshTokenHash).toBe(issued.refreshTokenHash);
        });
    });
});
