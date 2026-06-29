import { Types, type ClientSession } from "mongoose";
import { authConfig } from "../config";
import { ISession, SessionModel } from "./sessionModel";

type CreateSessionInput = {
    sessionId?: string;
    userId: string;
    refreshTokenHash: string;
    deviceId: string;
    userAgent?: string;
    ipAddress?: string;
};

export async function createSession({
    sessionId,
    userId,
    refreshTokenHash,
    deviceId,
    userAgent,
    ipAddress,
}: CreateSessionInput): Promise<ISession> {
    const _id = sessionId ? new Types.ObjectId(sessionId) : new Types.ObjectId();

    return SessionModel.create({
        _id,
        userId: new Types.ObjectId(userId),
        refreshTokenHash,
        deviceId,
        userAgent: userAgent || "Unknown",
        ipAddress: ipAddress || "Unknown",
        expiresAt: new Date(Date.now() + authConfig.session.refreshTtlMs),
        lastActiveAt: new Date(),
    });
}

export async function findSessionById(id: string): Promise<ISession | null> {
    return SessionModel.findById(id);
}

export async function findSessionByIdWithToken(id: string): Promise<ISession | null> {
    return SessionModel.findById(id).select("+refreshTokenHash");
}

export async function rotateSessionTokenHash(
    id: string,
    refreshTokenHash: string
): Promise<ISession | null> {
    return SessionModel.findByIdAndUpdate(
        id,
        {
            $set: {
                refreshTokenHash,
                state: "active",
                lastActiveAt: new Date(),
                expiresAt: new Date(Date.now() + authConfig.session.refreshTtlMs),
            },
        },
        { new: true }
    );
}

export async function markSessionStepUpPending(id: string): Promise<ISession | null> {
    return SessionModel.findByIdAndUpdate(
        id,
        { $set: { state: "step_up_pending", lastActiveAt: new Date() } },
        { new: true }
    );
}

export async function revokeSession(id: string): Promise<ISession | null> {
    return SessionModel.findByIdAndUpdate(
        id,
        { $set: { revokedAt: new Date() } },
        { new: true }
    );
}

export async function deleteSession(id: string): Promise<ISession | null> {
    return SessionModel.findByIdAndDelete(id);
}

export async function deleteUserSessions(
    userId: string,
    session?: ClientSession
): Promise<{ deletedCount?: number }> {
    return SessionModel.deleteMany(
        { userId: new Types.ObjectId(userId) },
        session ? { session } : undefined
    );
}