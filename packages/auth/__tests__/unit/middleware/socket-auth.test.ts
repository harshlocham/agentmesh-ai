import { describe, expect, it } from "vitest";
import { authenticateSocketToken } from "../../../middleware/socket-auth.js";
import {
    makeAccessToken,
    makeAlgNoneAccessToken,
    makeExpiredAccessToken,
    makeMalformedToken,
    makeRefreshToken,
    makeTamperedAccessToken,
    makeWrongSecretAccessToken,
} from "../../helpers/factories/jwt.factory.js";
import { objectId } from "../../helpers/ids.js";

describe("middleware/socket-auth", () => {
    it("authenticates a valid socket access token", () => {
        const userId = objectId();
        const token = makeAccessToken({
            sub: userId,
            role: "moderator",
            tokenVersion: 2,
        });

        expect(authenticateSocketToken(token)).toEqual({
            userId,
            role: "moderator",
        });
    });

    it("preserves an undefined role from a valid access token", () => {
        const userId = objectId();
        const token = makeAccessToken({
            sub: userId,
            role: undefined,
        });

        expect(authenticateSocketToken(token)).toEqual({
            userId,
            role: undefined,
        });
    });

    it("rejects a missing socket access token", () => {
        expect(() => authenticateSocketToken()).toThrow("Missing socket access token");
    });

    it("rejects an empty socket access token", () => {
        expect(() => authenticateSocketToken("")).toThrow("Missing socket access token");
    });

    it("rejects a malformed token string", () => {
        expect(() => authenticateSocketToken(makeMalformedToken())).toThrow();
    });

    it("rejects an expired access token", () => {
        expect(() => authenticateSocketToken(makeExpiredAccessToken())).toThrow();
    });

    it("rejects an access token signed with the wrong secret", () => {
        expect(() => authenticateSocketToken(makeWrongSecretAccessToken())).toThrow();
    });

    it("rejects a tampered access token", () => {
        expect(() => authenticateSocketToken(makeTamperedAccessToken())).toThrow();
    });

    it("rejects an alg=none access token", () => {
        expect(() => authenticateSocketToken(makeAlgNoneAccessToken())).toThrow();
    });

    it("rejects a refresh token", () => {
        expect(() => authenticateSocketToken(makeRefreshToken())).toThrow();
    });

    it("documents that middleware is stateless and returns only JWT claims", () => {
        const userId = objectId();
        const token = makeAccessToken({
            sub: userId,
            role: "admin",
            tokenVersion: 100,
        });

        // No database/user-state lookup happens here; stale tokenVersion and
        // account status checks are intentionally outside this middleware.
        expect(authenticateSocketToken(token)).toEqual({
            userId,
            role: "admin",
        });
    });
});
