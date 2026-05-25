import type { MessageDTO } from "../dto/message.dto";
import type { MessageTaskMetadata } from "../task/task";

export interface UIMessage extends Omit<MessageDTO, "createdAt" | "updatedAt">, MessageTaskMetadata {
    createdAt: Date;
    updatedAt?: Date;

    status: "pending" | "failed" | "sent" | "delivered" | "seen" | "queued";
    isTemp?: boolean;
}