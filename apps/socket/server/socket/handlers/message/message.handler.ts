import type { Redis } from "ioredis";
import type { Server as IOServer } from "socket.io";
import {
    type ClientToServerEvents,
    type MessageDTO,
    type MessageDeliveredUpdatePayload,
    type MessageSeenUpdatePayload,
    type ServerToClientEvents,
    SocketEvents,
} from "@chat/types";
import { authorizeConversationAccess } from "../../services/conversation-access-authorization.js";
import {
    clearActiveConversation,
    getActiveConversation,
    isUserOnline,
    setActiveConversation,
    setMessageDeliveryState,
} from "../../services/presence.redis.service.js";

type IO = IOServer<ClientToServerEvents, ServerToClientEvents>;
type Socket = import("socket.io").Socket<
    ClientToServerEvents,
    ServerToClientEvents
>;

const FORBIDDEN_JOIN_MESSAGE = "Unable to join conversation";

function auditUnauthorizedJoin(input: {
    userId: string;
    conversationId: string;
    socketId: string;
    reason: string;
}) {
    console.warn("socket.conversation.join.denied", {
        userId: input.userId,
        conversationId: input.conversationId,
        socketId: input.socketId,
        reason: input.reason,
    });
}

function resolveSocketUserRole(socket: Socket): "user" | "admin" {
    return socket.data.isAdmin ? "admin" : "user";
}

export function registerMessageHandlers(io: IO, socket: Socket, redis: Redis) {
    const conversationRoom = (id: string) => `conversation:${id}`;

    const toStringId = (value: unknown): string | null => {
        if (typeof value === "string" && value.trim()) {
            return value;
        }

        if (
            value
            && typeof value === "object"
            && "toString" in value
            && typeof (value as { toString: () => string }).toString === "function"
        ) {
            const str = (value as { toString: () => string }).toString();
            return str && str !== "[object Object]" ? str : null;
        }

        return null;
    };

    socket.on(SocketEvents.CONVERSATION_JOIN, async (payload: { conversationId: string }) => {
        const { conversationId } = payload;
        if (!conversationId) return;

        const authz = await authorizeConversationAccess({
            userId: socket.data.userId,
            conversationId,
            userRole: resolveSocketUserRole(socket),
        });

        if (!authz.allowed) {
            auditUnauthorizedJoin({
                userId: socket.data.userId,
                conversationId,
                socketId: socket.id,
                reason: authz.reason ?? "forbidden",
            });

            socket.emit(SocketEvents.ERROR_AUTH, {
                type: "conversation_join_forbidden",
                message: FORBIDDEN_JOIN_MESSAGE,
            });
            return;
        }

        socket.join(conversationRoom(conversationId));
        await setActiveConversation(redis, socket.data.userId, conversationId);
        socket.emit(SocketEvents.CONVERSATION_JOINED, { conversationId });
    });

    socket.on(SocketEvents.CONVERSATION_LEAVE, async (payload: { conversationId: string }) => {
        const { conversationId } = payload;
        if (!conversationId) return;

        socket.leave(conversationRoom(conversationId));
        await clearActiveConversation(redis, socket.data.userId, conversationId);
    });

    socket.on(
        SocketEvents.MESSAGE_SEND,
        async (
            payload: unknown,
            ack?: (res: { ok: boolean; error?: string }) => void
        ) => {
            try {
                const value = (payload ?? {}) as {
                    data?: MessageDTO;
                    message?: MessageDTO;
                    conversationMembers?: unknown[];
                    members?: unknown[];
                    recipients?: unknown[];
                };

                const data = value.data ?? value.message ?? (payload as MessageDTO);
                const conversationId = toStringId((data as { conversationId?: unknown })?.conversationId);
                const messageId = toStringId((data as { _id?: unknown; id?: unknown })?._id)
                    ?? toStringId((data as { _id?: unknown; id?: unknown })?.id);

                if (!conversationId || !messageId) {
                    ack?.({ ok: false, error: "Invalid message payload" });
                    return;
                }

                const authz = await authorizeConversationAccess({
                    userId: socket.data.userId,
                    conversationId,
                    userRole: resolveSocketUserRole(socket),
                });

                if (!authz.allowed || !authz.participantIds?.length) {
                    ack?.({ ok: false, error: "Forbidden" });
                    return;
                }

                const senderFromPayload = toStringId(
                    (data as { sender?: { _id?: unknown; id?: unknown } }).sender?._id
                ) ?? toStringId(
                    (data as { sender?: { _id?: unknown; id?: unknown } }).sender?.id
                );

                if (senderFromPayload && senderFromPayload !== socket.data.userId) {
                    ack?.({ ok: false, error: "Forbidden" });
                    return;
                }

                const normalizedData: MessageDTO = {
                    ...(data as MessageDTO),
                    _id: messageId,
                    conversationId,
                };

                const recipients = Array.from(new Set(authz.participantIds));

                io.to(conversationRoom(conversationId)).emit(SocketEvents.MESSAGE_NEW, normalizedData);

                for (const userId of recipients) {
                    io.to(`user:${userId}`).emit(SocketEvents.MESSAGE_NEW, normalizedData);
                }

                const senderId = socket.data.userId;
                const onlineRecipients: string[] = [];
                const seenUsers: string[] = [];

                for (const userId of recipients) {
                    if (userId === senderId) continue;

                    const online = await isUserOnline(redis, userId);
                    if (!online) continue;

                    onlineRecipients.push(userId);

                    const activeConversationId = await getActiveConversation(redis, userId);
                    if (activeConversationId === conversationId) {
                        seenUsers.push(userId);
                    }
                }

                const deliveredUsers = onlineRecipients;
                const at = new Date();

                if (seenUsers.length > 0) {
                    await setMessageDeliveryState(redis, messageId, "seen");
                } else if (deliveredUsers.length > 0) {
                    await setMessageDeliveryState(redis, messageId, "delivered");
                } else {
                    await setMessageDeliveryState(redis, messageId, "sent");
                }

                for (const userId of deliveredUsers) {
                    const deliveredPayload: MessageDeliveredUpdatePayload = {
                        messageId,
                        conversationId,
                        userId,
                        deliveredAt: at,
                    };
                    io.to(`user:${senderId}`).emit(
                        SocketEvents.MESSAGE_DELIVERED_UPDATE,
                        deliveredPayload
                    );
                }

                for (const userId of seenUsers) {
                    const seenPayload: MessageSeenUpdatePayload = {
                        conversationId,
                        messageIds: [messageId],
                        userId,
                        seenAt: at,
                    };
                    io.to(`user:${senderId}`).emit(
                        SocketEvents.MESSAGE_SEEN_UPDATE,
                        seenPayload
                    );
                }

                io.to("admins").emit(SocketEvents.DASHBOARD_UPDATE, { totalMessagesToday: 1 });
                ack?.({ ok: true });
            } catch (error) {
                console.error("message:send handler error", error);
                ack?.({ ok: false, error: "Unable to deliver message" });
            }
        }
    );
}
