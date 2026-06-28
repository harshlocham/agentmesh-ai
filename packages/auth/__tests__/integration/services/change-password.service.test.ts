import { describe, expect, it, vi } from "vitest";
import { Types } from "mongoose";
import { changePasswordService } from "../../../services/change-password.service.js";
import { comparePassword } from "../../../password/compare.js";
import { SessionModel } from "../../../repositories/sessionModel.js";
import { User } from "../../../../db/models/User.js";
import { useTestDb } from "../../helpers/db.js";
import { objectId } from "../../helpers/ids.js";
import { createUser } from "../../helpers/factories/user.factory.js";
import { createSessionDoc } from "../../helpers/factories/session.factory.js";

useTestDb();

const OLD_PASSWORD = "old-p4ssword";
const NEW_PASSWORD = "new-p4ssword";

function countSessions(userId: string): Promise<number> {
    return SessionModel.countDocuments({ userId: new Types.ObjectId(userId) });
}

async function readUser(userId: string) {
    return User.findById(userId).select("_id password tokenVersion").lean<{
        _id: Types.ObjectId;
        password?: string;
        tokenVersion?: number;
    } | null>();
}

describe("services/change-password.service (db integration)", () => {
    describe("happy path", () => {
        it("changes the password successfully", async () => {
            const user = await createUser({ plainPassword: OLD_PASSWORD });

            const result = await changePasswordService({
                userId: user._id.toString(),
                oldPassword: OLD_PASSWORD,
                newPassword: NEW_PASSWORD,
            });

            expect(result.success).toBe(true);
            expect(result.userId).toBe(user._id.toString());
        });

        it("updates the stored password hash", async () => {
            const user = await createUser({ plainPassword: OLD_PASSWORD });
            const before = await readUser(user._id.toString());

            await changePasswordService({
                userId: user._id.toString(),
                oldPassword: OLD_PASSWORD,
                newPassword: NEW_PASSWORD,
            });

            const after = await readUser(user._id.toString());
            expect(after?.password).not.toBe(before?.password);
        });

        it("invalidates the old password and accepts the new one", async () => {
            const user = await createUser({ plainPassword: OLD_PASSWORD });

            await changePasswordService({
                userId: user._id.toString(),
                oldPassword: OLD_PASSWORD,
                newPassword: NEW_PASSWORD,
            });

            const after = await readUser(user._id.toString());
            expect(await comparePassword(OLD_PASSWORD, after!.password!)).toBe(false);
            expect(await comparePassword(NEW_PASSWORD, after!.password!)).toBe(true);
        });

        it("revokes existing sessions and increments the persisted tokenVersion", async () => {
            const user = await createUser({ plainPassword: OLD_PASSWORD, tokenVersion: 2 });
            const userId = user._id.toString();
            await createSessionDoc({ userId });
            await createSessionDoc({ userId });

            await changePasswordService({
                userId,
                oldPassword: OLD_PASSWORD,
                newPassword: NEW_PASSWORD,
            });

            expect(await countSessions(userId)).toBe(0);
            const after = await readUser(userId);
            expect(after?.tokenVersion).toBe(3);
        });
    });

    describe("failure cases", () => {
        it("throws when the user does not exist", async () => {
            await expect(
                changePasswordService({
                    userId: objectId(),
                    oldPassword: OLD_PASSWORD,
                    newPassword: NEW_PASSWORD,
                })
            ).rejects.toThrow("User not found");
        });

        it("throws on a wrong old password and makes no changes", async () => {
            const user = await createUser({ plainPassword: OLD_PASSWORD, tokenVersion: 1 });
            const userId = user._id.toString();
            await createSessionDoc({ userId });
            const before = await readUser(userId);

            await expect(
                changePasswordService({
                    userId,
                    oldPassword: "wrong-old-password",
                    newPassword: NEW_PASSWORD,
                })
            ).rejects.toThrow("Current password is incorrect");

            const after = await readUser(userId);
            expect(after?.password).toBe(before?.password);
            expect(after?.tokenVersion).toBe(1);
            expect(await countSessions(userId)).toBe(1);
        });

        it("throws for an OAuth-only account with no password", async () => {
            const user = await createUser({ authProviders: ["google"], googleSub: "google-xyz" });

            await expect(
                changePasswordService({
                    userId: user._id.toString(),
                    oldPassword: OLD_PASSWORD,
                    newPassword: NEW_PASSWORD,
                })
            ).rejects.toThrow("User does not have password authentication enabled");
        });
    });

    describe("versioning (returned vs persisted)", () => {
        it("returns tokenVersionAfter matching the persisted value after invalidation", async () => {
            const user = await createUser({ plainPassword: OLD_PASSWORD, tokenVersion: 2 });
            const userId = user._id.toString();

            const result = await changePasswordService({
                userId,
                oldPassword: OLD_PASSWORD,
                newPassword: NEW_PASSWORD,
            });

            const persisted = await readUser(userId);

            expect(result.tokenVersionBefore).toBe(2);
            expect(result.tokenVersionAfter).toBe(3);
            expect(persisted?.tokenVersion).toBe(3);
            expect(result.tokenVersionAfter).toBe(persisted?.tokenVersion);
        });
    });

    describe("session invalidation", () => {
        it("removes all existing sessions (invalidateAllUserTokens executed)", async () => {
            const user = await createUser({ plainPassword: OLD_PASSWORD, tokenVersion: 0 });
            const userId = user._id.toString();
            await createSessionDoc({ userId });
            await createSessionDoc({ userId });
            await createSessionDoc({ userId });

            await changePasswordService({
                userId,
                oldPassword: OLD_PASSWORD,
                newPassword: NEW_PASSWORD,
            });

            // Both observable effects of invalidateAllUserTokens are present:
            // sessions deleted AND tokenVersion incremented.
            expect(await countSessions(userId)).toBe(0);
            const after = await readUser(userId);
            expect(after?.tokenVersion).toBe(1);
        });
    });

    describe("atomicity", () => {
        it("rolls back the password update when session deletion fails", async () => {
            const user = await createUser({ plainPassword: OLD_PASSWORD, tokenVersion: 1 });
            const userId = user._id.toString();
            await createSessionDoc({ userId });
            const before = await readUser(userId);

            const deleteManySpy = vi
                .spyOn(SessionModel, "deleteMany")
                .mockRejectedValueOnce(new Error("session delete failed"));

            await expect(
                changePasswordService({
                    userId,
                    oldPassword: OLD_PASSWORD,
                    newPassword: NEW_PASSWORD,
                })
            ).rejects.toThrow("session delete failed");

            const after = await readUser(userId);
            expect(after?.password).toBe(before?.password);
            expect(after?.tokenVersion).toBe(1);
            expect(await countSessions(userId)).toBe(1);

            deleteManySpy.mockRestore();
        });
    });

    describe("security", () => {
        it("rotates the hash even when the new password equals the old", async () => {
            const user = await createUser({ plainPassword: OLD_PASSWORD });
            const before = await readUser(user._id.toString());

            await changePasswordService({
                userId: user._id.toString(),
                oldPassword: OLD_PASSWORD,
                newPassword: OLD_PASSWORD,
            });

            const after = await readUser(user._id.toString());
            // Random salt => different hash string, but the password still verifies.
            expect(after?.password).not.toBe(before?.password);
            expect(await comparePassword(OLD_PASSWORD, after!.password!)).toBe(true);
        });

        it("stores only a bcrypt hash, never the plaintext", async () => {
            const user = await createUser({ plainPassword: OLD_PASSWORD });

            await changePasswordService({
                userId: user._id.toString(),
                oldPassword: OLD_PASSWORD,
                newPassword: NEW_PASSWORD,
            });

            const after = await readUser(user._id.toString());
            expect(after?.password).not.toBe(NEW_PASSWORD);
            expect(after?.password).toMatch(/^\$2[aby]\$/);
        });

        it("does not leak password hashes in the returned payload", async () => {
            const user = await createUser({ plainPassword: OLD_PASSWORD });
            const before = await readUser(user._id.toString());

            const result = await changePasswordService({
                userId: user._id.toString(),
                oldPassword: OLD_PASSWORD,
                newPassword: NEW_PASSWORD,
            });

            expect(Object.keys(result).sort()).toEqual(
                ["success", "tokenVersionAfter", "tokenVersionBefore", "userId"].sort()
            );
            const serialized = JSON.stringify(result);
            expect(serialized).not.toContain(NEW_PASSWORD);
            expect(serialized).not.toContain(OLD_PASSWORD);
            expect(serialized).not.toContain(before?.password);
        });
    });
});
