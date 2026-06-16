import { describe, expect, it } from "vitest";
import { authenticateHttpBearer } from "../../../middleware/http-auth.js";
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

describe("middleware/http-auth", () => {
    it("authenticates a valid Bearer access token", () => {
        const userId = objectId();
        const token = makeAccessToken({
            sub: userId,
            role: "admin",
            tokenVersion: 3,
        });

        expect(authenticateHttpBearer(`Bearer ${token}`)).toEqual({
            userId,
            role: "admin",
        });
    });

    it("accepts bearer scheme case-insensitively", () => {
        const userId = objectId();
        const token = makeAccessToken({ sub: userId, role: "moderator" });

        expect(authenticateHttpBearer(`bEaReR ${token}`)).toEqual({
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

        expect(authenticateHttpBearer(`Bearer ${token}`)).toEqual({
            userId,
            role: undefined,
        });
    });

    it("rejects a missing authorization header", () => {
        expect(() => authenticateHttpBearer()).toThrow("Missing authorization header");
    });

    it("rejects an authorization header with no token", () => {
        expect(() => authenticateHttpBearer("Bearer")).toThrow(
            "Invalid authorization header format"
        );
    });

    it("rejects a non-Bearer scheme", () => {
        expect(() => authenticateHttpBearer(`Basic ${makeAccessToken()}`)).toThrow(
            "Invalid authorization header format"
        );
    });

    it("rejects a malformed authorization header", () => {
        expect(() => authenticateHttpBearer(makeAccessToken())).toThrow(
            "Invalid authorization header format"
        );
    });

    it("rejects a malformed token string", () => {
        expect(() => authenticateHttpBearer(`Bearer ${makeMalformedToken()}`)).toThrow();
    });

    it("rejects an expired access token", () => {
        expect(() => authenticateHttpBearer(`Bearer ${makeExpiredAccessToken()}`)).toThrow();
    });

    it("rejects an access token signed with the wrong secret", () => {
        expect(() => authenticateHttpBearer(`Bearer ${makeWrongSecretAccessToken()}`)).toThrow();
    });

    it("rejects a tampered access token", () => {
        expect(() => authenticateHttpBearer(`Bearer ${makeTamperedAccessToken()}`)).toThrow();
    });

    it("rejects an alg=none access token", () => {
        expect(() => authenticateHttpBearer(`Bearer ${makeAlgNoneAccessToken()}`)).toThrow();
    });

    it("rejects a refresh token", () => {
        expect(() => authenticateHttpBearer(`Bearer ${makeRefreshToken()}`)).toThrow();
    });

    it("documents that middleware is stateless and returns only JWT claims", () => {
        const userId = objectId();
        const token = makeAccessToken({
            sub: userId,
            role: "user",
            tokenVersion: 99,
        });

        // No database/user-state lookup happens here; stale tokenVersion and
        // account status checks are intentionally outside this middleware.
        expect(authenticateHttpBearer(`Bearer ${token}`)).toEqual({
            userId,
            role: "user",
        });
    });
});
