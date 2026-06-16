import { User, type IUser } from "../../../../db/models/User.js";
import { hashPassword } from "../../../password/hash.js";

/**
 * Persisted User factory for database-integration tests.
 *
 * `buildUser` returns plain attributes; `createUser` writes a real row. When
 * `plainPassword` is provided it is hashed with real bcrypt; otherwise the
 * password is left unset (OAuth-style account). Emails are unique per call to
 * satisfy the unique email index.
 */
let userSeq = 0;

function uniqueEmail(): string {
    userSeq += 1;
    return `user-${Date.now().toString(36)}-${userSeq}@test.dev`;
}

export interface UserFactoryAttrs {
    username: string;
    email: string;
    plainPassword?: string;
    googleSub?: string;
    authProviders: Array<"password" | "google">;
    role: "user" | "moderator" | "admin";
    status: "active" | "banned";
    isBanned: boolean;
    isDeleted: boolean;
    isVerified: Date | undefined;
    tokenVersion: number;
}

export function buildUser(overrides: Partial<UserFactoryAttrs> = {}): UserFactoryAttrs {
    return {
        username: overrides.username ?? "Test User",
        email: overrides.email ?? uniqueEmail(),
        plainPassword: overrides.plainPassword,
        googleSub: overrides.googleSub,
        authProviders: overrides.authProviders ?? ["password"],
        role: overrides.role ?? "user",
        status: overrides.status ?? "active",
        isBanned: overrides.isBanned ?? false,
        isDeleted: overrides.isDeleted ?? false,
        isVerified: overrides.isVerified !== undefined ? overrides.isVerified : new Date(),
        tokenVersion: overrides.tokenVersion ?? 0,
    };
}

export async function createUser(overrides: Partial<UserFactoryAttrs> = {}): Promise<IUser> {
    const attrs = buildUser(overrides);
    const password = attrs.plainPassword ? await hashPassword(attrs.plainPassword) : undefined;

    return User.create({
        username: attrs.username,
        email: attrs.email,
        password,
        googleSub: attrs.googleSub,
        authProviders: attrs.authProviders,
        role: attrs.role,
        status: attrs.status,
        isBanned: attrs.isBanned,
        isDeleted: attrs.isDeleted,
        isVerified: attrs.isVerified,
        tokenVersion: attrs.tokenVersion,
        isOnline: false,
        conversations: [],
    });
}

export async function createActiveUser(
    overrides: Partial<UserFactoryAttrs> = {}
): Promise<IUser> {
    return createUser({ ...overrides, status: "active" });
}
