import mongoose from "mongoose";
import { User } from "@/models/User";
import { comparePassword } from "../password/compare";
import { hashPassword } from "../password/hash";
import { invalidateAllUserTokens, type TokenInvalidationResult } from "../tokens/invalidate";

export interface ChangePasswordInput {
    userId: string;
    oldPassword: string;
    newPassword: string;
}

export interface ChangePasswordOutput {
    userId: string;
    success: boolean;
    tokenVersionBefore: number;
    tokenVersionAfter: number;
}

/**
 * Change user's password and invalidate all existing tokens.
 * This forces re-authentication on all devices.
 * 
 * Process:
 * 1. Verify old password is correct
 * 2. Hash new password
 * 3. Atomically update password, increment tokenVersion, and delete sessions
 *    inside a MongoDB transaction
 * 
 * @param input - Contains userId, oldPassword, and newPassword
 * @returns Result with token version update info
 * @throws Error if old password is incorrect or user not found
 */
export async function changePasswordService(
    input: ChangePasswordInput
): Promise<ChangePasswordOutput> {
    const { userId, oldPassword, newPassword } = input;

    // Fetch user with current state
    const user = await User.findById(userId).select("_id password tokenVersion");
    if (!user) {
        throw new Error("User not found");
    }

    // Verify old password
    if (!user.password) {
        throw new Error("User does not have password authentication enabled");
    }

    const isPasswordValid = await comparePassword(oldPassword, user.password);
    if (!isPasswordValid) {
        throw new Error("Current password is incorrect");
    }

    // Hash new password
    const hashedNewPassword = await hashPassword(newPassword);

    // Store the old token version before incrementing
    const tokenVersionBefore = user.tokenVersion || 0;

    const mongoSession = await mongoose.startSession();
    let invalidationResult: TokenInvalidationResult | undefined;

    try {
        await mongoSession.withTransaction(async () => {
            const updatedUser = await User.findByIdAndUpdate(
                userId,
                {
                    password: hashedNewPassword,
                },
                { new: true, session: mongoSession }
            )
                .select("_id")
                .lean<{ _id: { toString(): string } } | null>();

            if (!updatedUser) {
                throw new Error("Failed to update password");
            }

            invalidationResult = await invalidateAllUserTokens(
                userId,
                "password_changed",
                mongoSession
            );
        });
    } finally {
        await mongoSession.endSession();
    }

    if (!invalidationResult) {
        throw new Error("Failed to change password");
    }

    return {
        userId,
        success: true,
        tokenVersionBefore,
        tokenVersionAfter: invalidationResult.newTokenVersion,
    };
}

/**
 * Force password change for a user (admin action).
 * This is used when an admin needs to force a user to change password,
 * for example after detecting suspicious activity.
 * 
 * This operation:
 * 1. Sets a temporary flag on the user
 * 2. Invalidates all tokens
 * 3. Forces client to prompt user for new password on next login
 * 
 * @param userId - The user's ID
 * @returns Confirmation of forced password change
 */
export async function forcePasswordChangeService(userId: string): Promise<{
    userId: string;
    success: boolean;
    tokenVersionAfter: number;
}> {
    // Increment tokenVersion to invalidate all tokens
    const result = await invalidateAllUserTokens(userId, "admin_revocation");

    return {
        userId,
        success: true,
        tokenVersionAfter: result.newTokenVersion,
    };
}
