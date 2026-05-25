import { describe, it, expect, beforeEach, vi } from "vitest";
import { User } from "@/models/User";
import {
    invalidateAllUserTokens,
    invalidateMultipleUserTokens,
    getUserTokenVersion,
    isTokenVersionValid,
} from "../tokens/invalidate.js";

// Mocks
vi.mock("@/models/User");
vi.mock("../repositories/session.repo", () => ({
    deleteUserSessions: vi.fn().mockResolvedValue({ deletedCount: 3 }),
}));
vi.mock("@/lib/utils/auth/userStateCache", () => ({
    clearCachedUserState: vi.fn().mockResolvedValue(undefined),
}));

describe("Token Versioning System", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe("invalidateAllUserTokens", () => {
        it("should increment tokenVersion and return invalidation result", async () => {
            const userId = "507f1f77bcf86cd799439011";
            const mockUser = {
                _id: { toString: () => userId },
                tokenVersion: 5,
            };

            vi.mocked(User.findByIdAndUpdate).mockReturnValue({
                select: () => ({
                    lean: () => Promise.resolve(mockUser),
                }),
            } as any);

            const result = await invalidateAllUserTokens(userId, "password_changed");

            expect(result.userId).toBe(userId);
            expect(result.previousTokenVersion).toBe(4);
            expect(result.newTokenVersion).toBe(5);
            expect(result.reason).toBe("password_changed");
            expect(result.timestamp).toBeInstanceOf(Date);
            expect(result.sessionsRevoked).toBe(3);
        });

        it("should handle user not found error", async () => {
            vi.mocked(User.findByIdAndUpdate).mockReturnValue({
                select: () => ({
                    lean: () => Promise.resolve(null),
                }),
            } as any);

            await expect(
                invalidateAllUserTokens("invalid-id", "password_changed")
            ).rejects.toThrow("User not found");
        });

        it("should support multiple invalidation reasons", async () => {
            const userId = "507f1f77bcf86cd799439011";
            const mockUser = {
                _id: { toString: () => userId },
                tokenVersion: 1,
            };

            vi.mocked(User.findByIdAndUpdate).mockReturnValue({
                select: () => ({
                    lean: () => Promise.resolve(mockUser),
                }),
            } as any);

            const reasons = [
                "password_changed",
                "account_compromise",
                "admin_revocation",
                "user_logout_all_devices",
                "account_banned",
            ] as const;

            for (const reason of reasons) {
                const result = await invalidateAllUserTokens(userId, reason);
                expect(result.reason).toBe(reason);
            }
        });

        it("should handle tokenVersion wrapping correctly", async () => {
            const userId = "507f1f77bcf86cd799439011";

            // First invalidation
            let mockUser = {
                _id: { toString: () => userId },
                tokenVersion: 1,
            };

            vi.mocked(User.findByIdAndUpdate).mockReturnValue({
                select: () => ({
                    lean: () => Promise.resolve(mockUser),
                }),
            } as any);

            let result = await invalidateAllUserTokens(userId, "password_changed");
            expect(result.previousTokenVersion).toBe(0);
            expect(result.newTokenVersion).toBe(1);

            // Second invalidation
            mockUser = {
                _id: { toString: () => userId },
                tokenVersion: 2,
            };

            result = await invalidateAllUserTokens(userId, "password_changed");
            expect(result.previousTokenVersion).toBe(1);
            expect(result.newTokenVersion).toBe(2);
        });
    });

    describe("getUserTokenVersion", () => {
        it("should return current tokenVersion for user", async () => {
            const userId = "507f1f77bcf86cd799439011";
            const mockUser = { tokenVersion: 3 };

            vi.mocked(User.findById).mockReturnValue({
                select: () => ({
                    lean: () => Promise.resolve(mockUser),
                }),
            } as any);

            const version = await getUserTokenVersion(userId);
            expect(version).toBe(3);
        });

        it("should return 0 if user not found", async () => {
            vi.mocked(User.findById).mockReturnValue({
                select: () => ({
                    lean: () => Promise.resolve(null),
                }),
            } as any);

            const version = await getUserTokenVersion("invalid-id");
            expect(version).toBe(0);
        });

        it("should return 0 if user has no tokenVersion", async () => {
            const mockUser = {}; // No tokenVersion field

            vi.mocked(User.findById).mockReturnValue({
                select: () => ({
                    lean: () => Promise.resolve(mockUser),
                }),
            } as any);

            const version = await getUserTokenVersion("user-id");
            expect(version).toBe(0);
        });
    });

    describe("isTokenVersionValid", () => {
        it("should return true if token version matches user version", async () => {
            const userId = "507f1f77bcf86cd799439011";

            vi.mocked(User.findById).mockReturnValue({
                select: () => ({
                    lean: () => Promise.resolve({ tokenVersion: 5 }),
                }),
            } as any);

            const isValid = await isTokenVersionValid(userId, 5);
            expect(isValid).toBe(true);
        });

        it("should return false if token version is outdated", async () => {
            const userId = "507f1f77bcf86cd799439011";

            vi.mocked(User.findById).mockReturnValue({
                select: () => ({
                    lean: () => Promise.resolve({ tokenVersion: 5 }),
                }),
            } as any);

            const isValid = await isTokenVersionValid(userId, 3);
            expect(isValid).toBe(false);
        });

        it("should return false if token version is ahead (future)", async () => {
            const userId = "507f1f77bcf86cd799439011";

            vi.mocked(User.findById).mockReturnValue({
                select: () => ({
                    lean: () => Promise.resolve({ tokenVersion: 3 }),
                }),
            } as any);

            const isValid = await isTokenVersionValid(userId, 5);
            expect(isValid).toBe(false);
        });

        it("should handle missing tokenVersion as 0", async () => {
            const userId = "507f1f77bcf86cd799439011";

            vi.mocked(User.findById).mockReturnValue({
                select: () => ({
                    lean: () => Promise.resolve({}), // No tokenVersion
                }),
            } as any);

            const isValid = await isTokenVersionValid(userId, 0);
            expect(isValid).toBe(true);
        });
    });

    describe("invalidateMultipleUserTokens", () => {
        it("should invalidate tokens for multiple users", async () => {
            const userIds = [
                "507f1f77bcf86cd799439011",
                "507f1f77bcf86cd799439012",
                "507f1f77bcf86cd799439013",
            ];

            vi.mocked(User.findByIdAndUpdate).mockReturnValue({
                select: () => ({
                    lean: () =>
                        Promise.resolve({
                            _id: { toString: () => "mocked" },
                            tokenVersion: 1,
                        }),
                }),
            } as any);

            const results = await invalidateMultipleUserTokens(userIds, "admin_revocation");

            expect(results).toHaveLength(3);
            expect(results.every((r) => r.reason === "admin_revocation")).toBe(true);
            expect(vi.mocked(User.findByIdAndUpdate)).toHaveBeenCalledTimes(3);
        });

        it("should handle multiple invalidation reasons correctly", async () => {
            const userIds = ["user1", "user2"];

            vi.mocked(User.findByIdAndUpdate).mockReturnValue({
                select: () => ({
                    lean: () =>
                        Promise.resolve({
                            _id: { toString: () => "id" },
                            tokenVersion: 1,
                        }),
                }),
            } as any);

            const results = await invalidateMultipleUserTokens(userIds, "account_compromise");

            expect(results).toHaveLength(2);
            expect(results.every((r) => r.reason === "account_compromise")).toBe(true);
        });
    });

    describe("Token Version Invalidation Scenarios", () => {
        it("should track invalidation reason for audit purposes", async () => {
            const userId = "507f1f77bcf86cd799439011";
            const reasons = [
                "password_changed",
                "account_compromise",
                "admin_revocation",
                "user_logout_all_devices",
                "account_banned",
                "account_deleted",
                "security_policy_change",
            ] as const;

            vi.mocked(User.findByIdAndUpdate).mockReturnValue({
                select: () => ({
                    lean: () =>
                        Promise.resolve({
                            _id: { toString: () => userId },
                            tokenVersion: 1,
                        }),
                }),
            } as any);

            for (const reason of reasons) {
                const result = await invalidateAllUserTokens(userId, reason);
                expect(result.reason).toBe(reason);
            }
        });

        it("should ensure session cleanup on invalidation", async () => {
            const userId = "507f1f77bcf86cd799439011";

            vi.mocked(User.findByIdAndUpdate).mockReturnValue({
                select: () => ({
                    lean: () =>
                        Promise.resolve({
                            _id: { toString: () => userId },
                            tokenVersion: 1,
                        }),
                }),
            } as any);

            const { deleteUserSessions } = await import("../repositories/session.repo");
            const result = await invalidateAllUserTokens(userId, "admin_revocation");

            expect(result.sessionsRevoked).toBe(3);
        });

        it("should handle concurrent invalidations", async () => {
            const userIds = ["user1", "user2", "user3", "user4", "user5"];

            vi.mocked(User.findByIdAndUpdate).mockReturnValue({
                select: () => ({
                    lean: () =>
                        Promise.resolve({
                            _id: { toString: () => "id" },
                            tokenVersion: Math.random(),
                        }),
                }),
            } as any);

            const results = await Promise.all(
                userIds.map((id) => invalidateAllUserTokens(id, "security_policy_change"))
            );

            expect(results).toHaveLength(5);
            expect(results.every((r) => r.reason === "security_policy_change")).toBe(true);
        });
    });
});
