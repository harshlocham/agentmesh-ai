import { describe, it, expect } from "vitest";
import { hashPassword } from "../../../password/hash.js";
import { comparePassword } from "../../../password/compare.js";

describe("password/hash (real bcrypt)", () => {
    it("hashes a password into a bcrypt string distinct from the plaintext", async () => {
        const hash = await hashPassword("correct horse battery staple");

        expect(typeof hash).toBe("string");
        expect(hash).not.toBe("correct horse battery staple");
        // bcryptjs emits the $2a$/$2b$ identifier.
        expect(hash).toMatch(/^\$2[aby]\$/);
    });

    it("uses a cost factor of 10", async () => {
        const hash = await hashPassword("some-password");
        const cost = hash.split("$")[2];
        expect(cost).toBe("10");
    });

    it("produces different hashes for the same password (random salt)", async () => {
        const first = await hashPassword("same-password");
        const second = await hashPassword("same-password");

        expect(first).not.toBe(second);
        // Both must still validate against the original password.
        expect(await comparePassword("same-password", first)).toBe(true);
        expect(await comparePassword("same-password", second)).toBe(true);
    });

    it("supports unicode passwords", async () => {
        const password = "пароль-密码-🔐-passwörd";
        const hash = await hashPassword(password);

        expect(await comparePassword(password, hash)).toBe(true);
        expect(await comparePassword("passwörd", hash)).toBe(false);
    });

    it("handles an empty-string password", async () => {
        const hash = await hashPassword("");

        expect(hash).toMatch(/^\$2[aby]\$/);
        expect(await comparePassword("", hash)).toBe(true);
        expect(await comparePassword("not-empty", hash)).toBe(false);
    });
});
