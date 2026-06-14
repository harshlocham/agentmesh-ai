import { describe, it, expect } from "vitest";
import { generateAccessToken, generateRefreshToken } from "../../../tokens/generate.js";
import { verifyAccessToken, verifyRefreshToken } from "../../../tokens/verify.js";
import { objectId } from "../../helpers/ids.js";

/**
 * Contract tests: the production signer and verifier must agree. These guard
 * against drift between generate.ts and verify.ts (algorithm, secret source,
 * claim shape).
 */
describe("tokens generate/verify contract", () => {
    it("verifies a generated access token successfully", () => {
        const sub = objectId();
        const token = generateAccessToken({ sub, role: "user", tokenVersion: 0, type: "access" });

        expect(() => verifyAccessToken(token)).not.toThrow();
    });

    it("verifies a generated refresh token successfully", () => {
        const sub = objectId();
        const sessionId = objectId();
        const token = generateRefreshToken({ sub, sessionId, tokenVersion: 0, type: "refresh" });

        expect(() => verifyRefreshToken(token)).not.toThrow();
    });

    it("preserves access token claims across a sign -> verify round trip", () => {
        const sub = objectId();
        const token = generateAccessToken({ sub, role: "admin", tokenVersion: 7, type: "access" });

        expect(verifyAccessToken(token)).toEqual({
            sub,
            role: "admin",
            tokenVersion: 7,
            type: "access",
        });
    });

    it("preserves refresh token claims across a sign -> verify round trip", () => {
        const sub = objectId();
        const sessionId = objectId();
        const token = generateRefreshToken({ sub, sessionId, tokenVersion: 9, type: "refresh" });

        expect(verifyRefreshToken(token)).toEqual({
            sub,
            sessionId,
            tokenVersion: 9,
            type: "refresh",
        });
    });
});
