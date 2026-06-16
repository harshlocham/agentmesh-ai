import { describe, expect, it } from "vitest";
import { Types } from "mongoose";
import { forcePasswordChangeService } from "../../../services/change-password.service.js";
import { SessionModel } from "../../../repositories/sessionModel.js";
import { User } from "../../../../db/models/User.js";
import { useTestDb } from "../../helpers/db.js";
import { objectId } from "../../helpers/ids.js";
import { createUser } from "../../helpers/factories/user.factory.js";
import { createSessionDoc } from "../../helpers/factories/session.factory.js";

useTestDb();

const PASSWORD = "orig-p4ssword";

function countSessions(userId: string): Promise<number> {
    return SessionModel.countDocuments({ userId: new Types.ObjectId(userId) });
}

/** Read the persisted user as a plain object (every field, nothing hidden). */
async function readFullUser(userId: string): Promise<Record<string, unknown> | null> {
    return User.findById(userId).lean<Record<string, unknown> | null>();
}

async function readTokenVersion(userId: string): Promise<number | undefined> {
    const user = await User.findById(userId)
        .select("tokenVersion")
        .lean<{ tokenVersion?: number } | null>();
    return user?.tokenVersion;
}

describe("services/force-password-change.service (db integration)", () => {
    describe("happy path", () => {
        it("succeeds and echoes the userId with success=true (req 1)", async () => {
            const user = await createUser({ plainPassword: PASSWORD });
            const userId = user._id.toString();

            const result = await forcePasswordChangeService(userId);

            expect(result.success).toBe(true);
            expect(result.userId).toBe(userId);
        });

        it("increments the persisted tokenVersion (req 2)", async () => {
            const user = await createUser({ plainPassword: PASSWORD, tokenVersion: 4 });
            const userId = user._id.toString();

            await forcePasswordChangeService(userId);

            expect(await readTokenVersion(userId)).toBe(5);
        });

        it("removes existing sessions (req 3)", async () => {
            const user = await createUser({ plainPassword: PASSWORD });
            const userId = user._id.toString();
            await createSessionDoc({ userId });
            await createSessionDoc({ userId });
            expect(await countSessions(userId)).toBe(2);

            await forcePasswordChangeService(userId);

            expect(await countSessions(userId)).toBe(0);
        });

        it("returns a payload that matches persisted state (req 4)", async () => {
            const user = await createUser({ plainPassword: PASSWORD, tokenVersion: 1 });
            const userId = user._id.toString();

            const result = await forcePasswordChangeService(userId);
            const persistedTokenVersion = await readTokenVersion(userId);

            expect(result).toEqual({
                userId,
                success: true,
                tokenVersionAfter: persistedTokenVersion,
            });
            expect(result.tokenVersionAfter).toBe(2);
        });
    });

    describe("failure paths", () => {
        it("throws 'User not found' for a non-existent user (req 5)", async () => {
            await expect(forcePasswordChangeService(objectId())).rejects.toThrow(
                "User not found"
            );
        });

        it("succeeds for a user with no active sessions (req 6)", async () => {
            const user = await createUser({ plainPassword: PASSWORD, tokenVersion: 0 });
            const userId = user._id.toString();
            expect(await countSessions(userId)).toBe(0);

            const result = await forcePasswordChangeService(userId);

            // No sessions to delete, but the token-version bump still happens.
            expect(result.success).toBe(true);
            expect(await countSessions(userId)).toBe(0);
            expect(await readTokenVersion(userId)).toBe(1);
        });

        it("removes ALL sessions for a user with multiple active sessions (req 7)", async () => {
            const user = await createUser({ plainPassword: PASSWORD });
            const userId = user._id.toString();
            await createSessionDoc({ userId });
            await createSessionDoc({ userId });
            await createSessionDoc({ userId });
            await createSessionDoc({ userId });
            expect(await countSessions(userId)).toBe(4);

            await forcePasswordChangeService(userId);

            expect(await countSessions(userId)).toBe(0);
        });

        it("only deletes the target user's sessions, not other users'", async () => {
            const target = (await createUser({ plainPassword: PASSWORD }))._id.toString();
            const bystander = (await createUser({ plainPassword: PASSWORD }))._id.toString();
            await createSessionDoc({ userId: target });
            await createSessionDoc({ userId: bystander });

            await forcePasswordChangeService(target);

            expect(await countSessions(target)).toBe(0);
            expect(await countSessions(bystander)).toBe(1);
        });
    });

    describe("versioning", () => {
        it("does NOT expose previousTokenVersion in the payload (req 8 - finding)", async () => {
            const user = await createUser({ plainPassword: PASSWORD, tokenVersion: 7 });
            const userId = user._id.toString();

            const result = await forcePasswordChangeService(userId);

            // FINDING: the underlying invalidateAllUserTokens computes
            // `previousTokenVersion`, but forcePasswordChangeService drops it.
            // The "previous" value is therefore NOT reported by this service.
            expect(result).not.toHaveProperty("previousTokenVersion");
            expect(Object.keys(result).sort()).toEqual(
                ["success", "tokenVersionAfter", "userId"].sort()
            );

            // The pre-change version (7) is only inferable from the persisted +1.
            expect(await readTokenVersion(userId)).toBe(8);
        });

        it("returns a tokenVersionAfter that matches the persisted value (req 9)", async () => {
            const user = await createUser({ plainPassword: PASSWORD, tokenVersion: 2 });
            const userId = user._id.toString();

            const result = await forcePasswordChangeService(userId);
            const persisted = await readTokenVersion(userId);

            // Unlike changePasswordService (which returns a stale value), this
            // service reads newTokenVersion from the post-increment document, so
            // the returned value is accurate.
            expect(result.tokenVersionAfter).toBe(3);
            expect(result.tokenVersionAfter).toBe(persisted);
        });

        it("starts versioning correctly from a brand-new (tokenVersion 0) user", async () => {
            const user = await createUser({ plainPassword: PASSWORD });
            const userId = user._id.toString();

            const result = await forcePasswordChangeService(userId);

            expect(result.tokenVersionAfter).toBe(1);
            expect(await readTokenVersion(userId)).toBe(1);
        });
    });

    describe("documentation verification", () => {
        it("writes NO 'must change password' flag anywhere on the user (req 10)", async () => {
            const user = await createUser({ plainPassword: PASSWORD });
            const userId = user._id.toString();

            await forcePasswordChangeService(userId);

            const persisted = await readFullUser(userId);
            expect(persisted).not.toBeNull();

            // FINDING: the docstring claims step 1 "Sets a temporary flag on the
            // user", but no such field is ever written. Assert the absence of
            // every plausible flag name.
            const flagCandidates = [
                "forcePasswordChange",
                "mustChangePassword",
                "passwordChangeRequired",
                "passwordResetRequired",
                "requirePasswordChange",
                "forcePasswordReset",
                "passwordExpired",
            ];
            for (const flag of flagCandidates) {
                expect(persisted).not.toHaveProperty(flag);
            }
        });

        it("changes ONLY tokenVersion (and the timestamps) on the user (req 11)", async () => {
            const user = await createUser({ plainPassword: PASSWORD, tokenVersion: 3 });
            const userId = user._id.toString();

            const before = (await readFullUser(userId))!;
            await forcePasswordChangeService(userId);
            const after = (await readFullUser(userId))!;

            // tokenVersion is the only domain field that moved.
            expect(before.tokenVersion).toBe(3);
            expect(after.tokenVersion).toBe(4);

            // Every other field is byte-for-byte identical (ignoring the
            // auto-managed updatedAt that mongoose timestamps bumps on update).
            const ignore = new Set(["tokenVersion", "updatedAt", "__v"]);
            const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
            for (const key of keys) {
                if (ignore.has(key)) continue;
                expect(JSON.stringify(after[key])).toBe(JSON.stringify(before[key]));
            }

            // The password hash specifically is untouched: this service does NOT
            // actually change any password despite its name.
            expect(after.password).toBe(before.password);
        });

        it("does NOT actually force a password change - it only revokes tokens (req 12)", async () => {
            // The docstring promises the operation will "force client to prompt
            // user for new password on next login". In reality the only durable
            // effects are: tokenVersion++ and session deletion. There is no
            // persisted signal a client could read to know a password change is
            // required, so the documented behavior is not implemented.
            const user = await createUser({ plainPassword: PASSWORD });
            const userId = user._id.toString();
            await createSessionDoc({ userId });

            const before = (await readFullUser(userId))!;
            await forcePasswordChangeService(userId);
            const after = (await readFullUser(userId))!;

            // Observable effects: tokens invalidated + sessions gone.
            expect(after.tokenVersion).toBe((before.tokenVersion as number) + 1);
            expect(await countSessions(userId)).toBe(0);

            // Password unchanged and no "change required" marker persisted, so a
            // client cannot distinguish this from an ordinary forced logout.
            expect(after.password).toBe(before.password);
        });
    });
});
