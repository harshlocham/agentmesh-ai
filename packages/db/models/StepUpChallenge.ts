import mongoose, { Document, Model, Schema, Types } from "mongoose";

export type StepUpChallengeStatus = "pending" | "verified" | "expired";
export type StepUpChallengeVerificationMethod = "password" | "otp";

type StepUpChallengeMetadata = {
    ip?: string;
    userAgent?: string;
};

type StepUpChallengeOtpState = {
    hash?: string;
    sentAt?: Date;
};

export interface IStepUpChallenge extends Document {
    id: string;
    userId: Types.ObjectId;
    sessionId: Types.ObjectId;
    status: StepUpChallengeStatus;
    verificationMethod: StepUpChallengeVerificationMethod;
    expiresAt: Date;
    createdAt: Date;
    metadata?: StepUpChallengeMetadata;
    otp?: StepUpChallengeOtpState;
}

const STEP_UP_TTL_MS = 5 * 60 * 1000;

const StepUpChallengeSchema = new Schema<IStepUpChallenge>(
    {
        userId: {
            type: Schema.Types.ObjectId,
            ref: "User",
            required: true,
            index: true,
        },
        sessionId: {
            type: Schema.Types.ObjectId,
            ref: "Session",
            required: true,
            index: true,
        },
        status: {
            type: String,
            enum: ["pending", "verified", "expired"],
            default: "pending",
            required: true,
            index: true,
        },
        verificationMethod: {
            type: String,
            enum: ["password", "otp"],
            default: "password",
            required: true,
        },
        expiresAt: {
            type: Date,
            required: true,
            default: () => new Date(Date.now() + STEP_UP_TTL_MS),
        },
        metadata: {
            ip: { type: String },
            userAgent: { type: String },
        },
        otp: {
            hash: { type: String },
            sentAt: { type: Date },
        },
    },
    {
        timestamps: { createdAt: true, updatedAt: false },
        versionKey: false,
    }
);

// Auto-delete challenges once expiration time is reached.
StepUpChallengeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
StepUpChallengeSchema.index({ userId: 1, sessionId: 1, status: 1 });

export const StepUpChallenge: Model<IStepUpChallenge> =
    (mongoose.models.StepUpChallenge as Model<IStepUpChallenge>) ||
    mongoose.model<IStepUpChallenge>("StepUpChallenge", StepUpChallengeSchema);

function assertValidObjectId(id: string, fieldName: "id" | "userId" | "sessionId"): Types.ObjectId {
    if (!Types.ObjectId.isValid(id)) {
        throw new Error(`Invalid ${fieldName}`);
    }
    return new Types.ObjectId(id);
}

export async function createChallenge(
    userId: string,
    sessionId: string,
    metadata?: StepUpChallengeMetadata
): Promise<IStepUpChallenge> {
    const safeUserId = assertValidObjectId(userId, "userId");
    const safeSessionId = assertValidObjectId(sessionId, "sessionId");

    return StepUpChallenge.create({
        userId: safeUserId,
        sessionId: safeSessionId,
        status: "pending",
        verificationMethod: "password",
        expiresAt: new Date(Date.now() + STEP_UP_TTL_MS),
        metadata,
    });
}

export async function recordChallengeOtp(id: string, otpHash: string): Promise<IStepUpChallenge | null> {
    const safeId = assertValidObjectId(id, "id");

    return StepUpChallenge.findOneAndUpdate(
        {
            _id: safeId,
            status: "pending",
            expiresAt: { $gt: new Date() },
        },
        {
            $set: {
                verificationMethod: "otp",
                otp: {
                    hash: otpHash,
                    sentAt: new Date(),
                },
            },
        },
        { new: true }
    );
}

export async function getChallengeById(id: string): Promise<IStepUpChallenge | null> {
    const safeId = assertValidObjectId(id, "id");

    const challenge = await StepUpChallenge.findById(safeId);
    if (!challenge) {
        return null;
    }

    if (challenge.status === "pending" && challenge.expiresAt.getTime() <= Date.now()) {
        challenge.status = "expired";
        await challenge.save();
    }

    return challenge;
}

export async function markChallengeVerified(id: string): Promise<IStepUpChallenge | null> {
    const safeId = assertValidObjectId(id, "id");

    return StepUpChallenge.findOneAndUpdate(
        {
            _id: safeId,
            status: "pending",
            expiresAt: { $gt: new Date() },
        },
        {
            $set: { status: "verified" },
            $unset: {
                "otp.hash": "",
                "otp.sentAt": "",
            },
        },
        { new: true }
    );
}

export async function expireChallenge(id: string): Promise<IStepUpChallenge | null> {
    const safeId = assertValidObjectId(id, "id");

    return StepUpChallenge.findOneAndUpdate(
        {
            _id: safeId,
            status: "pending",
        },
        {
            $set: {
                status: "expired",
                expiresAt: new Date(),
            },
        },
        { new: true }
    );
}
