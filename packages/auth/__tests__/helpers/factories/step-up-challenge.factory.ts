import { Types } from "mongoose";
import {
    StepUpChallenge,
    type IStepUpChallenge,
    type StepUpChallengeStatus,
    type StepUpChallengeVerificationMethod,
} from "../../../../db/models/StepUpChallenge.js";
import { objectId } from "../ids.js";

/**
 * Persisted StepUpChallenge factory for database-integration tests.
 *
 * `buildStepUpChallenge` returns plain attributes; `createStepUpChallengeDoc`
 * writes a real row to the in-memory Mongo instance. The `_id` is derived from
 * `challengeId` so the value passed to the service resolves to the created row.
 */
const STEP_UP_TTL_MS = 5 * 60 * 1000;

export interface StepUpChallengeFactoryAttrs {
    challengeId: string;
    userId: string;
    status: StepUpChallengeStatus;
    verificationMethod: StepUpChallengeVerificationMethod;
    expiresAt: Date;
    metadata?: { ip?: string; userAgent?: string };
    otp?: { hash?: string; sentAt?: Date };
}

export function buildStepUpChallenge(
    overrides: Partial<StepUpChallengeFactoryAttrs> = {}
): StepUpChallengeFactoryAttrs {
    return {
        challengeId: overrides.challengeId ?? objectId(),
        userId: overrides.userId ?? objectId(),
        status: overrides.status ?? "pending",
        verificationMethod: overrides.verificationMethod ?? "password",
        expiresAt: overrides.expiresAt ?? new Date(Date.now() + STEP_UP_TTL_MS),
        metadata: overrides.metadata,
        otp: overrides.otp,
    };
}

export async function createStepUpChallengeDoc(
    overrides: Partial<StepUpChallengeFactoryAttrs> = {}
): Promise<IStepUpChallenge> {
    const attrs = buildStepUpChallenge(overrides);
    return StepUpChallenge.create({
        _id: new Types.ObjectId(attrs.challengeId),
        userId: new Types.ObjectId(attrs.userId),
        status: attrs.status,
        verificationMethod: attrs.verificationMethod,
        expiresAt: attrs.expiresAt,
        metadata: attrs.metadata,
        otp: attrs.otp,
    });
}

/** A fresh, pending password challenge (the common step-up entry point). */
export async function createPendingPasswordChallenge(
    overrides: Partial<StepUpChallengeFactoryAttrs> = {}
): Promise<IStepUpChallenge> {
    return createStepUpChallengeDoc({
        ...overrides,
        status: "pending",
        verificationMethod: overrides.verificationMethod ?? "password",
    });
}

/**
 * A challenge that is still flagged `pending` in storage but whose `expiresAt`
 * is in the past. Note: `getChallengeById` lazily flips such a row to
 * `expired` on read.
 */
export async function createExpiredChallenge(
    overrides: Partial<StepUpChallengeFactoryAttrs> = {}
): Promise<IStepUpChallenge> {
    return createStepUpChallengeDoc({
        ...overrides,
        status: "pending",
        expiresAt: overrides.expiresAt ?? new Date(Date.now() - 60_000),
    });
}

/** A challenge that has already been consumed/verified. */
export async function createVerifiedChallenge(
    overrides: Partial<StepUpChallengeFactoryAttrs> = {}
): Promise<IStepUpChallenge> {
    return createStepUpChallengeDoc({ ...overrides, status: "verified" });
}
