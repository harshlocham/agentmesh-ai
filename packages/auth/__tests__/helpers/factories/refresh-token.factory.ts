import { generateRefreshToken } from "../../../tokens/generate.js";
import { hashToken } from "../../../session/token-hash.js";
import { rotateSessionTokenHash } from "../../../repositories/session.repo.js";
import type { ISession } from "../../../repositories/sessionModel.js";
import { createSessionDoc, type SessionFactoryAttrs } from "./session.factory.js";
import { objectId } from "../ids.js";

/**
 * Refresh-token factory.
 *
 * Uses the REAL production signer (`generateRefreshToken`) and REAL hashing
 * (`hashToken`) so the persisted session hash and the issued token are
 * genuinely coordinated. This is what lets verifySession's constant-time hash
 * comparison succeed on the happy path and fail on tampered/rotated tokens.
 */
export interface MintedRefreshToken {
    refreshToken: string;
    refreshTokenHash: string;
    sessionId: string;
    userId: string;
    tokenVersion: number;
}

/** Mint a signature-valid refresh token + its hash, WITHOUT persisting a session. */
export function mintRefreshToken(
    input: { userId?: string; sessionId?: string; tokenVersion?: number } = {}
): MintedRefreshToken {
    const userId = input.userId ?? objectId();
    const sessionId = input.sessionId ?? objectId();
    const tokenVersion = input.tokenVersion ?? 0;

    const refreshToken = generateRefreshToken({
        sub: userId,
        sessionId,
        tokenVersion,
        type: "refresh",
    });

    return {
        refreshToken,
        refreshTokenHash: hashToken(refreshToken),
        sessionId,
        userId,
        tokenVersion,
    };
}

export type IssueRefreshTokenInput = {
    userId?: string;
    sessionId?: string;
    tokenVersion?: number;
} & Pick<Partial<SessionFactoryAttrs>, "state" | "revokedAt" | "expiresAt" | "deviceId" | "userAgent" | "ipAddress">;

/**
 * Mint a refresh token AND persist a matching session row whose stored hash
 * equals `hashToken(refreshToken)`. The returned token verifies successfully
 * against the created session.
 */
export async function issueRefreshTokenForSession(
    input: IssueRefreshTokenInput = {}
): Promise<{ session: ISession } & MintedRefreshToken> {
    const minted = mintRefreshToken({
        userId: input.userId,
        sessionId: input.sessionId,
        tokenVersion: input.tokenVersion,
    });

    const session = await createSessionDoc({
        sessionId: minted.sessionId,
        userId: minted.userId,
        refreshTokenHash: minted.refreshTokenHash,
        state: input.state,
        revokedAt: input.revokedAt,
        expiresAt: input.expiresAt,
        deviceId: input.deviceId,
        userAgent: input.userAgent,
        ipAddress: input.ipAddress,
    });

    return { session, ...minted };
}

/**
 * Simulate a real token rotation: mint a replacement token and rotate the
 * stored session hash to it via the production repository. After this call, the
 * ORIGINAL `issued.refreshToken` is stale (its hash no longer matches storage).
 * Returns the replacement token (now the valid one).
 */
export async function rotateSessionToNewToken(issued: {
    sessionId: string;
    userId: string;
    tokenVersion: number;
}): Promise<MintedRefreshToken> {
    const replacement = mintRefreshToken({
        userId: issued.userId,
        sessionId: issued.sessionId,
        // Bump version so the replacement payload (and thus hash) differs from
        // the original even if signed within the same second.
        tokenVersion: issued.tokenVersion + 1,
    });

    await rotateSessionTokenHash(issued.sessionId, replacement.refreshTokenHash);
    return replacement;
}
