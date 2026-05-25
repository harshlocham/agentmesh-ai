import type { CreateMessageInput } from "../../../../../packages/services/validators/message.schema.js";

export async function handleCreateMessage(data: CreateMessageInput, senderId: string) {
    // Socket server is transport-only by architecture.
    // Message persistence must happen in the web/API layer.
    return {
        conversationId: data.conversationId,
        senderId,
        content: data.content,
        messageType: data.messageType,
    };
}
