import { describe, expect, it } from "vitest";
import { Types } from "mongoose";
import {
    getUserTokenVersion,
    invalidateAllUserTokens,
    invalidateMultipleUserTokens,
    invalidateUserToken,
    isTokenVersionValid,
} from "../../../tokens/invalidate.js";
import { SessionModel } from "../../../repositories/sessionModel.js";
import { User } from "../../../../db/models/User.js";
import { useTestDb } from "../../helpers/db.js";
import { objectId } from "../../helpers/ids.js";
import { createUser } from "../../helpers/factories/user.factory.js";
import { createSessionDoc } from "../../helpers/factories/session.factory.js";

useTestDb();

function countSessions(userId: string): Promise<number> {
    return SessionModel.countDocuments({ userId: new Types.ObjectId(userId) });
}

describe("tokens/invalidate (db integration)", () => {
    describe("getUserTokenVersion", () => {
        it("returns the stored tokenVersion", async () => {
            const user = await createUser({ tokenVersion: 5 });
            expect(await getUserTokenVersion(user._id.toString())).toBe(5);
        });

        it("returns 0 for a non-existent user", async () => {
            expect(await getUserTokenVersion(objectId())).toBe(0);
        });

        it("treats an absent tokenVersion field as 0", async () => {
            // Raw insert bypasses the schema default so tokenVersion is undefined.
            const id = new Types.ObjectId();
            await User.collection.insertOne({
                _id: id,
                username: "no-version",
                email: `no-version-${id.toString()}@test.dev`,
            });

            expect(await getUserTokenVersion(id.toString())).toBe(0);
        });
    });

    describe("isTokenVersionValid", () => {
        it("returns true when the version matches the current version", async () => {
            const user = await createUser({ tokenVersion: 3 });
            expect(await isTokenVersionValid(user._id.toString(), 3)).toBe(true);
        });

        it("returns false when the version does not match", async () => {
            const user = await createUser({ tokenVersion: 3 });
            expect(await isTokenVersionValid(user._id.toString(), 2)).toBe(false);
        });

        it("treats a missing user as version 0 (token v0 reads as valid)", async () => {
            const missing = objectId();
            // Documents a sharp edge: a non-existent user resolves to version 0,
            // so a v0 token is reported valid even though the user is gone.
            expect(await isTokenVersionValid(missing, 0)).toBe(true);
            expect(await isTokenVersionValid(missing, 1)).toBe(false);
        });
    });

    describe("invalidateUserToken", () => {
        it("increments tokenVersion and returns previous/current versions", async () => {
            const user = await createUser({ tokenVersion: 2 });

            const result = await invalidateUserToken(user._id.toString(), "password_changed");

            expect(result.previousTokenVersion).toBe(2);
            expect(result.newTokenVersion).toBe(3);
            expect(result.reason).toBe("password_changed");
            expect(await getUserTokenVersion(user._id.toString())).toBe(3);
        });

        it("deletes the user's sessions", async () => {
            const user = await createUser();
            const userId = user._id.toString();
            await createSessionDoc({ userId });
            await createSessionDoc({ userId });

            const result = await invalidateUserToken(userId, "account_compromise");

            expect(result.sessionsRevoked).toBe(2);
            expect(await countSessions(userId)).toBe(0);
        });
    });

    describe("invalidateAllUserTokens", () => {
        it("increments tokenVersion and reports the version transition", async () => {
            const user = await createUser({ tokenVersion: 7 });

            const result = await invalidateAllUserTokens(user._id.toString(), "admin_revocation");

            expect(result.userId).toBe(user._id.toString());
            expect(result.previousTokenVersion).toBe(7);
            expect(result.newTokenVersion).toBe(8);
            expect(result.timestamp).toBeInstanceOf(Date);
        });

        it("removes all sessions and reports the deletedCount", async () => {
            const user = await createUser();
            const userId = user._id.toString();
            await createSessionDoc({ userId });
            await createSessionDoc({ userId });
            await createSessionDoc({ userId });

            const result = await invalidateAllUserTokens(userId, "security_policy_change");

            expect(result.sessionsRevoked).toBe(3);
            expect(await countSessions(userId)).toBe(0);
        });

        it("reports sessionsRevoked 0 when the user has no sessions", async () => {
            const user = await createUser();
            const result = await invalidateAllUserTokens(user._id.toString(), "password_changed");
            expect(result.sessionsRevoked).toBe(0);
        });

        it("throws when the user does not exist", async () => {
            await expect(
                invalidateAllUserTokens(objectId(), "admin_revocation")
            ).rejects.toThrow("User not found");
        });

        it("never returns a negative previousTokenVersion (version 0 -> 1)", async () => {
            const user = await createUser({ tokenVersion: 0 });
            const result = await invalidateAllUserTokens(user._id.toString(), "password_changed");

            expect(result.newTokenVersion).toBe(1);
            expect(result.previousTokenVersion).toBe(0);
            expect(result.previousTokenVersion).toBeGreaterThanOrEqual(0);
        });

        it("treats an absent tokenVersion as 0 and increments to 1", async () => {
            const id = new Types.ObjectId();
            await User.collection.insertOne({
                _id: id,
                username: "no-version-invalidate",
                email: `no-version-inv-${id.toString()}@test.dev`,
            });

            const result = await invalidateAllUserTokens(id.toString(), "password_changed");
            expect(result.newTokenVersion).toBe(1);
            expect(result.previousTokenVersion).toBe(0);
        });
    });

    describe("invalidateMultipleUserTokens", () => {
        it("invalidates multiple valid users and preserves input order", async () => {
            const userA = await createUser({ tokenVersion: 1 });
            const userB = await createUser({ tokenVersion: 4 });
            await createSessionDoc({ userId: userA._id.toString() });
            await createSessionDoc({ userId: userB._id.toString() });

            const results = await invalidateMultipleUserTokens(
                [userA._id.toString(), userB._id.toString()],
                "account_banned"
            );

            expect(results).toHaveLength(2);
            expect(results[0].userId).toBe(userA._id.toString());
            expect(results[0].newTokenVersion).toBe(2);
            expect(results[1].userId).toBe(userB._id.toString());
            expect(results[1].newTokenVersion).toBe(5);

            expect(await countSessions(userA._id.toString())).toBe(0);
            expect(await countSessions(userB._id.toString())).toBe(0);
        });

        it("rejects the whole batch when any user is missing", async () => {
            const userA = await createUser({ tokenVersion: 0 });

            await expect(
                invalidateMultipleUserTokens(
                    [userA._id.toString(), objectId()],
                    "admin_revocation"
                )
            ).rejects.toThrow("User not found");
        });

        it("does NOT roll back already-applied mutations on partial failure", async () => {
            const userA = await createUser({ tokenVersion: 0 });
            const userId = userA._id.toString();
            await createSessionDoc({ userId });

            let rejected = false;
            try {
                await invalidateMultipleUserTokens([userId, objectId()], "admin_revocation");
            } catch {
                rejected = true;
            }
            expect(rejected).toBe(true);

            // Let any in-flight write for the valid user settle.
            await new Promise((resolve) => setTimeout(resolve, 100));

            // BUG/inconsistency: the valid user was still mutated despite the
            // batch rejecting — Promise.all provides no atomicity or rollback.
            expect(await getUserTokenVersion(userId)).toBe(1);
            expect(await countSessions(userId)).toBe(0);
        });
    });
});
