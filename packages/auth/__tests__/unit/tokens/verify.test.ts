import { describe, it, expect } from "vitest";
import { verifyAccessToken, verifyRefreshToken } from "../../../tokens/verify.js";
import {
    makeAccessToken,
    makeRefreshToken,
    makeExpiredAccessToken,
    makeExpiredRefreshToken,
    makeWrongSecretAccessToken,
    makeTamperedAccessToken,
    makeAlgNoneAccessToken,
    makeMalformedToken,
} from "../../helpers/factories/jwt.factory.js";
import { objectId } from "../../helpers/ids.js";

describe("tokens/verify", () => {
    describe("verifyAccessToken", () => {
        it("accepts a valid access token and returns the payload", () => {
            const sub = objectId();
            const token = makeAccessToken({ sub, role: "moderator", tokenVersion: 2 });

            const payload = verifyAccessToken(token);

            expect(payload).toEqual({
                sub,
                role: "moderator",
                tokenVersion: 2,
                type: "access",
            });
        });

        it("rejects an expired access token", () => {
            expect(() => verifyAccessToken(makeExpiredAccessToken())).toThrow();
        });

        it("rejects an access token signed with the wrong secret", () => {
            expect(() => verifyAccessToken(makeWrongSecretAccessToken())).toThrow();
        });

        it("rejects a tampered access token", () => {
            expect(() => verifyAccessToken(makeTamperedAccessToken())).toThrow();
        });

        it("rejects an alg=none token", () => {
            expect(() => verifyAccessToken(makeAlgNoneAccessToken())).toThrow();
        });

        it("rejects a malformed token string", () => {
            expect(() => verifyAccessToken(makeMalformedToken())).toThrow();
        });

        it("rejects a refresh token (wrong verifier)", () => {
            expect(() => verifyAccessToken(makeRefreshToken())).toThrow();
        });

        it("rejects a token whose type claim is not 'access'", () => {
            // Correctly signed with the access secret, but type says refresh.
            const token = makeAccessToken({ type: "refresh" as never });
            expect(() => verifyAccessToken(token)).toThrow("Invalid access token payload");
        });

        it("rejects a negative tokenVersion", () => {
            const token = makeAccessToken({ tokenVersion: -1 });
            expect(() => verifyAccessToken(token)).toThrow("Invalid access token payload");
        });

        it("rejects a non-integer tokenVersion", () => {
            const token = makeAccessToken({ tokenVersion: 1.5 });
            expect(() => verifyAccessToken(token)).toThrow("Invalid access token payload");
        });

        it("rejects an unknown role", () => {
            const token = makeAccessToken({ role: "superadmin" as never });
            expect(() => verifyAccessToken(token)).toThrow("Invalid access token role");
        });
    });

    describe("verifyRefreshToken", () => {
        it("accepts a valid refresh token and returns the payload", () => {
            const sub = objectId();
            const sessionId = objectId();
            const token = makeRefreshToken({ sub, sessionId, tokenVersion: 4 });

            const payload = verifyRefreshToken(token);

            expect(payload).toEqual({
                sub,
                sessionId,
                tokenVersion: 4,
                type: "refresh",
            });
        });

        it("rejects an expired refresh token", () => {
            expect(() => verifyRefreshToken(makeExpiredRefreshToken())).toThrow();
        });

        it("rejects an access token (wrong verifier)", () => {
            expect(() => verifyRefreshToken(makeAccessToken())).toThrow();
        });

        it("rejects a token whose type claim is not 'refresh'", () => {
            const token = makeRefreshToken({ type: "access" as never });
            expect(() => verifyRefreshToken(token)).toThrow("Invalid refresh token payload");
        });

        it("rejects a refresh token missing sessionId", () => {
            const token = makeRefreshToken({ sessionId: undefined as never });
            expect(() => verifyRefreshToken(token)).toThrow("Invalid refresh token payload");
        });

        it("rejects a negative tokenVersion", () => {
            const token = makeRefreshToken({ tokenVersion: -1 });
            expect(() => verifyRefreshToken(token)).toThrow("Invalid refresh token payload");
        });
    });
});
