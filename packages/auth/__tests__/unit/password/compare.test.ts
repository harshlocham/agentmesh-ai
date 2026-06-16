import { describe, it, expect } from "vitest";
import { hashPassword } from "../../../password/hash.js";
import { comparePassword } from "../../../password/compare.js";

describe("password/compare (real bcrypt)", () => {
    it("returns true for the correct password", async () => {
        const hash = await hashPassword("s3cr3t-p4ss");
        expect(await comparePassword("s3cr3t-p4ss", hash)).toBe(true);
    });

    it("returns false for an incorrect password", async () => {
        const hash = await hashPassword("s3cr3t-p4ss");
        expect(await comparePassword("wrong-password", hash)).toBe(false);
    });

    it("is case-sensitive", async () => {
        const hash = await hashPassword("CaseSensitive");
        expect(await comparePassword("casesensitive", hash)).toBe(false);
        expect(await comparePassword("CaseSensitive", hash)).toBe(true);
    });

    it("returns false (does not throw) against a non-bcrypt hash string", async () => {
        expect(await comparePassword("anything", "not-a-real-hash")).toBe(false);
    });
});
