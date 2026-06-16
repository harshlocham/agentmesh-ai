import { describe, it, expect, vi } from "vitest";
import crypto from "node:crypto";
import { hashToken, tokenHashEquals } from "../../../session/token-hash.js";

describe("session/token-hash", () => {
    describe("hashToken", () => {
        it("hashes deterministically (same input => same output)", () => {
            expect(hashToken("refresh-token-abc")).toBe(hashToken("refresh-token-abc"));
        });

        it("matches the known SHA-256 hex vector for the empty string", () => {
            expect(hashToken("")).toBe(
                "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
            );
        });

        it("produces a 64-char hex digest", () => {
            expect(hashToken("anything")).toMatch(/^[0-9a-f]{64}$/);
        });

        it("produces different digests for different tokens", () => {
            expect(hashToken("token-a")).not.toBe(hashToken("token-b"));
        });
    });

    describe("tokenHashEquals", () => {
        it("returns true for identical hashes (same token)", () => {
            const hash = hashToken("token-xyz");
            expect(tokenHashEquals(hash, hash)).toBe(true);
        });

        it("returns false for different hashes (different token)", () => {
            expect(tokenHashEquals(hashToken("token-a"), hashToken("token-b"))).toBe(false);
        });

        it("returns false (without throwing) for different-length inputs", () => {
            // Guards against crypto.timingSafeEqual throwing on length mismatch.
            expect(() => tokenHashEquals("short", "a-much-longer-string")).not.toThrow();
            expect(tokenHashEquals("short", "a-much-longer-string")).toBe(false);
        });

        it("routes equal-length comparisons through crypto.timingSafeEqual", () => {
            const spy = vi.spyOn(crypto, "timingSafeEqual");

            const left = hashToken("same");
            const right = hashToken("same");
            const differing = hashToken("different"); // still 64 chars

            expect(tokenHashEquals(left, right)).toBe(true);
            expect(tokenHashEquals(left, differing)).toBe(false);
            // Both equal-length calls must reach the constant-time comparator.
            expect(spy).toHaveBeenCalledTimes(2);

            spy.mockRestore();
        });
    });
});
