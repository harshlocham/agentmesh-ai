import { Types } from "mongoose";
import { authConfig } from "../../../config.js";
import { hashToken } from "../../../session/token-hash.js";
import { findSessionByIdWithToken } from "../../../repositories/session.repo.js";
import {
    ISession,
    SessionModel,
    SessionState,
} from "../../../repositories/sessionModel.js";
import { objectId } from "../ids.js";

/**
 * Persisted AuthSession factory for database-integration tests.
 *
 * `buildSession` returns plain attributes; `createSessionDoc` writes a real row
 * to the in-memory Mongo instance. The `_id` is set from `sessionId` so refresh
 * tokens (whose payload carries `sessionId`) resolve to the row by id.
 */
export interface SessionFactoryAttrs {
    sessionId: string;
    userId: string;
    refreshTokenHash: string;
    deviceId: string;
    userAgent: string;
    ipAddress: string;
    expiresAt: Date;
    revokedAt: Date | null;
    state: SessionState;
}

function defaults(): SessionFactoryAttrs {
    return {
        sessionId: objectId(),
        userId: objectId(),
        refreshTokenHash: hashToken("default-refresh-token"),
        deviceId: hashToken("default-device"),
        userAgent: "test-user-agent",
        ipAddress: "127.0.0.1",
        expiresAt: new Date(Date.now() + authConfig.session.refreshTtlMs),
        revokedAt: null,
        state: "active",
    };
}

export function buildSession(
    overrides: Partial<SessionFactoryAttrs> = {}
): SessionFactoryAttrs {
    const d = defaults();
    return {
        sessionId: overrides.sessionId ?? d.sessionId,
        userId: overrides.userId ?? d.userId,
        refreshTokenHash: overrides.refreshTokenHash ?? d.refreshTokenHash,
        deviceId: overrides.deviceId ?? d.deviceId,
        userAgent: overrides.userAgent ?? d.userAgent,
        ipAddress: overrides.ipAddress ?? d.ipAddress,
        expiresAt: overrides.expiresAt ?? d.expiresAt,
        revokedAt: overrides.revokedAt !== undefined ? overrides.revokedAt : d.revokedAt,
        state: overrides.state ?? d.state,
    };
}

export async function createSessionDoc(
    overrides: Partial<SessionFactoryAttrs> = {}
): Promise<ISession> {
    const attrs = buildSession(overrides);
    return SessionModel.create({
        _id: new Types.ObjectId(attrs.sessionId),
        userId: new Types.ObjectId(attrs.userId),
        refreshTokenHash: attrs.refreshTokenHash,
        deviceId: attrs.deviceId,
        userAgent: attrs.userAgent,
        ipAddress: attrs.ipAddress,
        expiresAt: attrs.expiresAt,
        revokedAt: attrs.revokedAt,
        state: attrs.state,
        lastActiveAt: new Date(),
    });
}

export async function createActiveSession(
    overrides: Partial<SessionFactoryAttrs> = {}
): Promise<ISession> {
    return createSessionDoc({ ...overrides, state: "active", revokedAt: null });
}

export async function createRevokedSession(
    overrides: Partial<SessionFactoryAttrs> = {}
): Promise<ISession> {
    return createSessionDoc({ ...overrides, revokedAt: overrides.revokedAt ?? new Date() });
}

export async function createExpiredSession(
    overrides: Partial<SessionFactoryAttrs> = {}
): Promise<ISession> {
    return createSessionDoc({
        ...overrides,
        expiresAt: overrides.expiresAt ?? new Date(Date.now() - 60_000),
    });
}

export async function createStepUpPendingSession(
    overrides: Partial<SessionFactoryAttrs> = {}
): Promise<ISession> {
    return createSessionDoc({ ...overrides, state: "step_up_pending" });
}

/**
 * Create a session whose `refreshTokenHash` is absent. The schema marks the
 * field required, so we strip it via a raw collection update (bypassing
 * validators) to simulate a legacy/corrupt row and exercise the "missing stored
 * hash" rejection branch.
 */
export async function createSessionWithoutTokenHash(
    overrides: Partial<SessionFactoryAttrs> = {}
): Promise<ISession> {
    const session = await createSessionDoc(overrides);
    await SessionModel.collection.updateOne(
        { _id: session._id },
        { $unset: { refreshTokenHash: "" } }
    );
    const reloaded = await findSessionByIdWithToken(session._id.toString());
    if (!reloaded) {
        throw new Error("createSessionWithoutTokenHash: failed to reload session");
    }
    return reloaded;
}
