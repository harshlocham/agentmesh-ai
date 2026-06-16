import { describe, expect, it } from "vitest";
import { Types } from "mongoose";
import { loginUser } from "../../../services/login.service.js";
import { verifyAccessToken } from "../../../tokens/verify.js";
import { verifySession } from "../../../session/verify-session.js";
import { SessionModel } from "../../../repositories/sessionModel.js";
import { useTestDb } from "../../helpers/db.js";
import { createUser } from "../../helpers/factories/user.factory.js";

useTestDb();

const PASSWORD = "s3cret-p4ssword";

function countSessions(userId: string): Promise<number> {
    return SessionModel.countDocuments({ userId: new Types.ObjectId(userId) });
}

describe("services/login.service (db integration)", () => {
    describe("happy path", () => {
        it("returns the user and tokens and persists a verifiable session", async () => {
            const user = await createUser({ plainPassword: PASSWORD });
            const userId = user._id.toString();

            const result = await loginUser({ email: user.email, password: PASSWORD });

            expect(result.user._id.toString()).toBe(userId);

            // Access token is valid and carries the subject.
            const accessPayload = verifyAccessToken(result.accessToken);
            expect(accessPayload.sub).toBe(userId);

            // Refresh token resolves to a real, persisted session for this user.
            const { session, payload } = await verifySession(result.refreshToken);
            expect(payload.sub).toBe(userId);
            expect(String(session.userId)).toBe(userId);

            expect(await countSessions(userId)).toBe(1);
        });

        it("embeds the user's role and tokenVersion in the access token", async () => {
            const user = await createUser({
                plainPassword: PASSWORD,
                role: "admin",
                tokenVersion: 9,
            });

            const result = await loginUser({ email: user.email, password: PASSWORD });
            const payload = verifyAccessToken(result.accessToken);

            expect(payload.role).toBe("admin");
            expect(payload.tokenVersion).toBe(9);
        });

        it("normalizes the email (case-insensitive, trimmed)", async () => {
            const user = await createUser({
                plainPassword: PASSWORD,
                email: "casetest@example.com",
            });

            const result = await loginUser({
                email: "  CaseTest@Example.COM  ",
                password: PASSWORD,
            });

            expect(result.user._id.toString()).toBe(user._id.toString());
        });
    });

    describe("failure paths", () => {
        it("throws when the user does not exist", async () => {
            await expect(
                loginUser({ email: "nobody@example.com", password: PASSWORD })
            ).rejects.toThrow("User not found");
        });

        it("throws when the account has no password (OAuth-only)", async () => {
            const user = await createUser({ authProviders: ["google"], googleSub: "google-123" });

            await expect(
                loginUser({ email: user.email, password: PASSWORD })
            ).rejects.toThrow("Password login is not enabled for this account");
        });

        it("throws on an incorrect password and persists no session", async () => {
            const user = await createUser({ plainPassword: PASSWORD });

            await expect(
                loginUser({ email: user.email, password: "wrong-password" })
            ).rejects.toThrow("Invalid password");

            expect(await countSessions(user._id.toString())).toBe(0);
        });

        it("throws for a non-active account even with the correct password", async () => {
            const user = await createUser({ plainPassword: PASSWORD, status: "banned" });

            await expect(
                loginUser({ email: user.email, password: PASSWORD })
            ).rejects.toThrow("Account is not active");

            // No session is issued for a blocked account.
            expect(await countSessions(user._id.toString())).toBe(0);
        });
    });

    describe("security findings", () => {
        it("uses distinct messages for missing user vs wrong password (enumeration risk)", async () => {
            const user = await createUser({ plainPassword: PASSWORD });

            const missingMessage = await loginUser({
                email: "ghost@example.com",
                password: PASSWORD,
            }).catch((e: Error) => e.message);

            const wrongPasswordMessage = await loginUser({
                email: user.email,
                password: "wrong-password",
            }).catch((e: Error) => e.message);

            // Documents that the two cases are distinguishable by an attacker.
            expect(missingMessage).toBe("User not found");
            expect(wrongPasswordMessage).toBe("Invalid password");
            expect(missingMessage).not.toBe(wrongPasswordMessage);
        });

        it("checks password before account status, leaking password validity for banned accounts", async () => {
            const user = await createUser({ plainPassword: PASSWORD, status: "banned" });

            // Wrong password on a banned account reports "Invalid password"
            // (not "Account is not active"), revealing the password was wrong.
            await expect(
                loginUser({ email: user.email, password: "wrong-password" })
            ).rejects.toThrow("Invalid password");
        });
    });
});
