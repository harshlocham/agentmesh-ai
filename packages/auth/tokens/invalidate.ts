import mongoose from "mongoose";
import { User } from "@/models/User";
import { deleteUserSessions } from "../repositories/session.repo";
import type { ClientSession } from "mongoose";

export type InvalidationReason =
    | "password_changed"
    | "account_compromise"
    | "admin_revocation"
    | "user_logout_all_devices"
    | "account_banned"
    | "account_deleted"
    | "security_policy_change";

export interface TokenInvalidationResult {
    userId: string;
    previousTokenVersion: number;
    newTokenVersion: number;
    reason: InvalidationReason;
    sessionsRevoked: number;
    timestamp: Date;
}

/**
 * Invalidates all tokens for a user by incrementing their tokenVersion.
 * This instantly revokes all JWT tokens across all devices.
 * 
 * Use cases:
 * - Password change: Force user to re-authenticate
 * - Account compromise: Admin action to revoke suspicious tokens
 * - Force logout all devices: User action to logout from everywhere
 * - Account ban/deletion: Prevent access immediately
 * 
 * @param userId - The user's ID
 * @param reason - The reason for token invalidation
 * @returns Invalidation result with version numbers
 */
export async function invalidateAllUserTokens(
    userId: string,
    reason: InvalidationReason,
    mongoSession?: ClientSession
): Promise<TokenInvalidationResult> {
    const user = await User.findByIdAndUpdate(
        userId,
        { $inc: { tokenVersion: 1 } },
        { new: true, session: mongoSession }
    )
        .select("_id tokenVersion")
        .lean<{ _id: { toString(): string }; tokenVersion?: number } | null>();

    if (!user) {
        throw new Error("User not found");
    }

    const newTokenVersion = user.tokenVersion || 0;
    const previousTokenVersion = Math.max(0, newTokenVersion - 1);

    // Delete all active sessions from database (session cleanup)
    const deleteResult = await deleteUserSessions(user._id.toString(), mongoSession);
    const sessionsRevoked = deleteResult.deletedCount || 0;

    return {
        userId: user._id.toString(),
        previousTokenVersion,
        newTokenVersion,
        reason,
        sessionsRevoked,
        timestamp: new Date(),
    };
}

/**
 * Invalidates a specific token for a user by incrementing tokenVersion.
 * This is a convenience wrapper around invalidateAllUserTokens for scenarios
 * where you want to invalidate just one token, but in practice it invalidates
 * all tokens since tokenVersion is user-global.
 * 
 * @param userId - The user's ID
 * @param reason - The reason for invalidation
 * @returns Invalidation result
 */
export async function invalidateUserToken(
    userId: string,
    reason: InvalidationReason
): Promise<TokenInvalidationResult> {
    return invalidateAllUserTokens(userId, reason);
}

/**
 * Batch invalidate tokens for multiple users (e.g., account takedown campaign).
 * All users are processed inside a single MongoDB transaction; if any user fails,
 * no mutations from the batch are committed.
 *
 * @param userIds - Array of user IDs to invalidate
 * @param reason - The reason for batch invalidation
 * @returns Array of invalidation results in input order
 */
export async function invalidateMultipleUserTokens(
    userIds: string[],
    reason: InvalidationReason
): Promise<TokenInvalidationResult[]> {
    if (userIds.length === 0) {
        return [];
    }

    const mongoSession = await mongoose.startSession();
    const results: TokenInvalidationResult[] = [];

    try {
        await mongoSession.withTransaction(async () => {
            for (const userId of userIds) {
                const result = await invalidateAllUserTokens(userId, reason, mongoSession);
                results.push(result);
            }
        });
    } finally {
        await mongoSession.endSession();
    }

    return results;
}

/**
 * Get the current tokenVersion for a user.
 * Used to check if a token needs validation without full auth check.
 * 
 * @param userId - The user's ID
 * @returns Current tokenVersion, or 0 if user not found
 */
export async function getUserTokenVersion(userId: string): Promise<number> {
    const user = await User.findById(userId)
        .select("tokenVersion")
        .lean<{ tokenVersion?: number } | null>();

    return user?.tokenVersion || 0;
}

/**
 * Check if a token's version is still valid against current user state.
 * Used for explicit token validation without full auth context.
 * 
 * @param userId - The user's ID
 * @param tokenVersion - The tokenVersion from the JWT token
 * @returns true if token version is still valid, false if revoked
 */
export async function isTokenVersionValid(
    userId: string,
    tokenVersion: number
): Promise<boolean> {
    const currentVersion = await getUserTokenVersion(userId);
    return currentVersion === tokenVersion;
}
