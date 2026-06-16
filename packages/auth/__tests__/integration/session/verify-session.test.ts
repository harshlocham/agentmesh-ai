import { afterEach, describe, expect, it, vi } from "vitest";
import { verifySession } from "../../../session/verify-session.js";
import { hashToken } from "../../../session/token-hash.js";
import {
    findSessionById,
    findSessionByIdWithToken,
} from "../../../repositories/session.repo.js";
import { SessionModel } from "../../../repositories/sessionModel.js";
import { useTestDb } from "../../helpers/db.js";
import { objectId } from "../../helpers/ids.js";
import { createUser } from "../../helpers/factories/user.factory.js";
import {
    createSessionDoc,
    createSessionWithoutTokenHash,
} from "../../helpers/factories/session.factory.js";
import {
    issueRefreshTokenForSession,
    mintRefreshToken,
    rotateSessionToNewToken,
} from "../../helpers/factories/refresh-token.factory.js";

useTestDb();

describe("session/verify-session (db integration)", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe("happy path", () => {
        it("returns the session and payload for a valid token + active session", async () => {
            const user = await createUser();
            const userId = user._id.toString();

            const issued = await issueRefreshTokenForSession({ userId, tokenVersion: 2 });

            const { session, payload } = await verifySession(issued.refreshToken);

            expect(payload).toEqual({
                sub: userId,
                sessionId: issued.sessionId,
                tokenVersion: 2,
                type: "refresh",
            });
            expect(session._id.toString()).toBe(issued.sessionId);
            expect(String(session.userId)).toBe(userId);
        });
    });

    describe("session state", () => {
        it("rejects when the session does not exist", async () => {
            // Token is signature-valid but no session row was persisted.
            const minted = mintRefreshToken();

            await expect(verifySession(minted.refreshToken)).rejects.toThrow("Invalid session");
        });

        it("rejects a revoked session", async () => {
            const user = await createUser();
            const issued = await issueRefreshTokenForSession({
                userId: user._id.toString(),
                revokedAt: new Date(),
            });

            await expect(verifySession(issued.refreshToken)).rejects.toThrow("Session revoked");
        });

        it("rejects an expired session", async () => {
            const user = await createUser();
            const issued = await issueRefreshTokenForSession({
                userId: user._id.toString(),
                expiresAt: new Date(Date.now() - 60_000),
            });

            await expect(verifySession(issued.refreshToken)).rejects.toThrow("Session expired");
        });
    });

    describe("token integrity", () => {
        it("accepts a token whose hash matches the stored hash", async () => {
            const user = await createUser();
            const issued = await issueRefreshTokenForSession({ userId: user._id.toString() });

            await expect(verifySession(issued.refreshToken)).resolves.toBeTruthy();

            // The stored hash is exactly the SHA-256 of the issued token.
            const stored = await findSessionByIdWithToken(issued.sessionId);
            expect(stored?.refreshTokenHash).toBe(hashToken(issued.refreshToken));
        });

        it("rejects a token whose hash does not match the stored hash", async () => {
            const user = await createUser();
            const minted = mintRefreshToken({ userId: user._id.toString() });

            // Persist a session bound to the same user/session id, but store a
            // different hash so the presented token cannot match.
            await createSessionDoc({
                sessionId: minted.sessionId,
                userId: minted.userId,
                refreshTokenHash: hashToken("some-other-token"),
            });

            await expect(verifySession(minted.refreshToken)).rejects.toThrow(
                "Invalid session token"
            );
        });

        it("rejects a rotated/stale refresh token", async () => {
            const user = await createUser();
            const issued = await issueRefreshTokenForSession({
                userId: user._id.toString(),
                tokenVersion: 1,
            });

            // Rotate the session to a new token; the original is now stale.
            const replacement = await rotateSessionToNewToken({
                sessionId: issued.sessionId,
                userId: issued.userId,
                tokenVersion: issued.tokenVersion,
            });

            await expect(verifySession(issued.refreshToken)).rejects.toThrow(
                "Invalid session token"
            );
            // Sanity: the replacement token is accepted.
            await expect(verifySession(replacement.refreshToken)).resolves.toBeTruthy();
        });
    });

    describe("binding", () => {
        it("rejects when the session userId does not match the token subject", async () => {
            const tokenUserId = objectId();
            const otherUserId = objectId();
            const minted = mintRefreshToken({ userId: tokenUserId });

            // Session bound to a different user but with a matching token hash,
            // so only the user-binding check can fail.
            await createSessionDoc({
                sessionId: minted.sessionId,
                userId: otherUserId,
                refreshTokenHash: minted.refreshTokenHash,
            });

            await expect(verifySession(minted.refreshToken)).rejects.toThrow(
                "Invalid session user binding"
            );
        });

        it("rejects when the stored refreshTokenHash is missing", async () => {
            const minted = mintRefreshToken();

            await createSessionWithoutTokenHash({
                sessionId: minted.sessionId,
                userId: minted.userId,
            });

            await expect(verifySession(minted.refreshToken)).rejects.toThrow(
                "Invalid session token"
            );
        });
    });

    describe("security", () => {
        it("never persists the raw refresh token", async () => {
            const user = await createUser();
            const issued = await issueRefreshTokenForSession({ userId: user._id.toString() });

            // Raw document inspection: no field equals the raw token.
            const raw = await SessionModel.collection.findOne({
                _id: SessionModel.base.Types.ObjectId.createFromHexString(issued.sessionId),
            });
            expect(JSON.stringify(raw)).not.toContain(issued.refreshToken);

            // Only the hash is stored, and it is not reversible to the token.
            expect(raw?.refreshTokenHash).toBe(hashToken(issued.refreshToken));
            expect(raw?.refreshTokenHash).not.toBe(issued.refreshToken);

            // Default reads do not even surface the hash (select: false).
            const defaultRead = await findSessionById(issued.sessionId);
            expect(defaultRead?.refreshTokenHash).toBeUndefined();
        });

        it("does not leak the refresh token or its hash in logs or errors", async () => {
            const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

            const user = await createUser();
            const minted = mintRefreshToken({ userId: user._id.toString() });
            await createSessionDoc({
                sessionId: minted.sessionId,
                userId: minted.userId,
                refreshTokenHash: hashToken("a-different-token"),
            });

            let caught: unknown;
            try {
                await verifySession(minted.refreshToken);
            } catch (error) {
                caught = error;
            }

            expect(caught).toBeInstanceOf(Error);
            // Error message is generic; it must not embed the token or its hash.
            expect((caught as Error).message).toBe("Invalid session token");
            expect((caught as Error).message).not.toContain(minted.refreshToken);

            const loggedOutput = warnSpy.mock.calls
                .map((call) => JSON.stringify(call))
                .join(" ");
            expect(loggedOutput).not.toContain(minted.refreshToken);
            expect(loggedOutput).not.toContain(minted.refreshTokenHash);
        });
    });
});
