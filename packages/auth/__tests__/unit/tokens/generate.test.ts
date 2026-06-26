import { describe, it, expect } from "vitest";
import { generateAccessToken, generateRefreshToken } from "../../../tokens/generate.js";
import { objectId } from "../../helpers/ids.js";
import { expectAlg, expectClaims, expectNotExpired, decodeJwt } from "../../helpers/assertions/token-assertions.js";

describe("tokens/generate (real JWT signing)", () => {
    it("generates an access token with HS256 and the expected claims", () => {
        const sub = objectId();
        const token = generateAccessToken({
            sub,
            role: "user",
            tokenVersion: 0,
            type: "access",
        });

        expect(token.split(".")).toHaveLength(3);
        expectAlg(token, "HS256");
        expectClaims(token, { sub, role: "user", tokenVersion: 0, type: "access" });
        expectNotExpired(token);
    });

    it("generates a refresh token carrying the sessionId claim", () => {
        const sub = objectId();
        const sessionId = objectId();
        const token = generateRefreshToken({
            sub,
            sessionId,
            tokenVersion: 3,
            type: "refresh",
        });

        expect(token.split(".")).toHaveLength(3);
        expectAlg(token, "HS256");
        expectClaims(token, { sub, sessionId, tokenVersion: 3, type: "refresh" });
        expectNotExpired(token);
        expect(decodeJwt<{ jti?: string }>(token).jti).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
        );
    });

    it("generates distinct refresh tokens for identical payloads within the same second", () => {
        const payload = {
            sub: objectId(),
            sessionId: objectId(),
            tokenVersion: 0,
            type: "refresh" as const,
        };

        const first = generateRefreshToken(payload);
        const second = generateRefreshToken(payload);

        expect(first).not.toBe(second);
        expect(decodeJwt<{ jti?: string }>(first).jti).not.toBe(
            decodeJwt<{ jti?: string }>(second).jti
        );
    });

    it("stamps an expiry (exp) on generated tokens", () => {
        const token = generateAccessToken({
            sub: objectId(),
            role: "admin",
            tokenVersion: 1,
            type: "access",
        });

        const { exp, iat } = decodeJwt<{ exp?: number; iat?: number }>(token);
        expect(exp).toBeTypeOf("number");
        expect(iat).toBeTypeOf("number");
        // Access tokens are configured for 15m.
        expect(exp! - iat!).toBe(15 * 60);
    });
});
