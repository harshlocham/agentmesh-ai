import mongoose from "mongoose";
import OutboxEventModel, { type IOutboxEvent, type OutboxTopic } from "@chat/db/models/OutboxEvent";
import { connectToDatabase } from "@chat/db";

export interface EnqueueOutboxEventInput {
    topic: OutboxTopic;
    dedupeKey: string;
    payload: Record<string, unknown>;
    session?: mongoose.ClientSession;
}

export async function enqueueOutboxEvent(input: EnqueueOutboxEventInput) {
    await connectToDatabase();

    const doc = new OutboxEventModel({
        topic: input.topic,
        dedupeKey: input.dedupeKey,
        payload: input.payload,
        status: "pending",
        attempts: 0,
        availableAt: new Date(),
    });

    await doc.save(input.session ? { session: input.session } : undefined);
    return doc;
}

export async function claimOutboxEvents(workerId: string, limit = 10): Promise<IOutboxEvent[]> {
    await connectToDatabase();

    const now = new Date();
    const staleProcessingCutoff = new Date(Date.now() - 5 * 60 * 1000);
    const claimed: IOutboxEvent[] = [];

    for (let i = 0; i < limit; i += 1) {
        const doc = await OutboxEventModel.findOneAndUpdate(
            {
                $or: [
                    {
                        status: { $in: ["pending", "failed"] },
                        availableAt: { $lte: now },
                    },
                    {
                        status: "processing",
                        lockedAt: { $lte: staleProcessingCutoff },
                    },
                ],
            },
            {
                $set: {
                    status: "processing",
                    lockedBy: workerId,
                    lockedAt: new Date(),
                },
                $inc: { attempts: 1 },
            },
            {
                sort: { createdAt: 1 },
                new: true,
            }
        );

        if (!doc) break;
        claimed.push(doc);
    }

    return claimed;
}

export async function markOutboxEventCompleted(id: string) {
    await connectToDatabase();
    await OutboxEventModel.updateOne(
        { _id: id },
        {
            $set: {
                status: "completed",
                processedAt: new Date(),
                deadLetteredAt: null,
                lockedBy: null,
                lockedAt: null,
                lastError: null,
            },
        }
    );
}

export async function markOutboxEventFailed(id: string, errorMessage: string, retryDelayMs = 1000) {
    await connectToDatabase();
    await OutboxEventModel.updateOne(
        { _id: id },
        {
            $set: {
                status: "failed",
                availableAt: new Date(Date.now() + retryDelayMs),
                deadLetteredAt: null,
                lockedBy: null,
                lockedAt: null,
                lastError: errorMessage.slice(0, 4000),
            },
        }
    );
}

export async function markOutboxEventDeadLetter(id: string, errorMessage: string) {
    await connectToDatabase();
    await OutboxEventModel.updateOne(
        { _id: id },
        {
            $set: {
                status: "dead_letter",
                deadLetteredAt: new Date(),
                lockedBy: null,
                lockedAt: null,
                lastError: errorMessage.slice(0, 4000),
            },
        }
    );
}