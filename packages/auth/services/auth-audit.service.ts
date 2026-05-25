import { connection, Types } from "mongoose";
import { AuthEventModel, AuthEventType } from "../repositories/authEventModel";

type AuthAuditInput = {
    eventType: AuthEventType;
    outcome: "success" | "failure";
    userId?: string;
    email?: string;
    ipAddress?: string;
    userAgent?: string;
    reason?: string;
    metadata?: Record<string, unknown>;
};

function normalizeOptionalText(value?: string, maxLength = 512): string | undefined {
    if (!value) {
        return undefined;
    }

    const normalized = value.trim();
    if (!normalized) {
        return undefined;
    }

    return normalized.slice(0, maxLength);
}

export async function logAuthEventBestEffort(input: AuthAuditInput): Promise<void> {
    try {
        if (connection.readyState !== 1) {
            return;
        }

        if (input.userId && !Types.ObjectId.isValid(input.userId)) {
            return;
        }

        await AuthEventModel.create({
            eventType: input.eventType,
            outcome: input.outcome,
            userId: input.userId ? new Types.ObjectId(input.userId) : undefined,
            email: normalizeOptionalText(input.email, 320),
            ipAddress: normalizeOptionalText(input.ipAddress, 128) || "unknown",
            userAgent: normalizeOptionalText(input.userAgent, 512) || "Unknown",
            reason: normalizeOptionalText(input.reason, 512),
            metadata: input.metadata,
        });
    } catch (error) {
        console.error("[auth-audit] failed to persist auth event", error);
    }
}
