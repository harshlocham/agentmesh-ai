"use client";

import { io, Socket } from "socket.io-client";
import {
    type ClientConversation,
    type MessageDTO,
    type ServerToClientEvents,
    type ClientToServerEvents,
    SocketEvents,
    type TypingPayload,
    // SocketEvents,
} from "@chat/types";
import useChatStore from "@/store/chat-store";
import { registerTaskSocketListeners } from "@/hooks/socketListeners";
import { isMessageDTO } from "@chat/types/utils/message.guard";
import { UIMessage } from "@chat/types";
import { getClientSocketUrl } from "@/lib/socket/socketConfig";

let socketInstance: Socket<ServerToClientEvents, ClientToServerEvents> | null =
    null;
const typingExpiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
const conversationFetchInFlight = new Map<string, Promise<ClientConversation | null>>();
const registeredHandlers = new Map<string, (...args: any[]) => void>();

export type TypedSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/**
 * Create (once) and return the singleton socket instance.
 * Safe to call from client components.
 */
export function getSocket(): TypedSocket {
    if (!socketInstance) {
        socketInstance = io(getClientSocketUrl(), {
            path: "/api/socket",
            autoConnect: false, // you control when to connect
            transports: ["websocket", "polling"],
            reconnection: true,
            reconnectionAttempts: Infinity,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 7000,
            timeout: 20000,
            closeOnBeforeunload: true,
            withCredentials: true,
        });
    }

    return socketInstance;
}

/**
 * Backwards-compatible export if you were doing:
 *   import { socket } from "@/lib/socketClient";
 *
 * NOTE: Only use this inside "use client" components.
 */
export const socket = getSocket();

/**
 * Optional helper: connect with auth token (if you use JWT/header auth)
 */
export function connectSocket(authToken?: string) {
    const s = getSocket();

    if (authToken) {
        s.io.opts.extraHeaders = {
            ...(s.io.opts.extraHeaders || {}),
            Authorization: `Bearer ${authToken}`,
        };
    }

    if (!s.connected) {
        s.connect();
    }
}

/**
 * Optional helper: disconnect socket
 */
export function disconnectSocket() {
    const s = getSocket();
    if (s.connected) {
        s.disconnect();
    }
}
let listenersRegistered = false;
export function registerGlobalSocketListeners() {
    if (listenersRegistered) return;
    listenersRegistered = true;

    const fetchConversationById = async (conversationId: string): Promise<ClientConversation | null> => {
        const id = String(conversationId || "").trim();
        if (!id) return null;

        const existingRequest = conversationFetchInFlight.get(id);
        if (existingRequest) {
            return existingRequest;
        }

        const request = (async () => {
            try {
                // Use authenticatedFetch so we wait for auth bootstrap and single-flight refresh
                const response = await (await import("@/lib/utils/api")).authenticatedFetch(`/api/conversations/${id}`);
                if (!response.ok) {
                    return null;
                }

                const conversation = (await response.json()) as ClientConversation;
                useChatStore.getState().upsertConversation(conversation);
                return conversation;
            } catch (err) {
                console.error("Failed to fetch conversation", err);
                return null;
            }
        })()
            .catch((error) => {
                console.error("Failed to fetch conversation", error);
                return null;
            })
            .finally(() => {
                conversationFetchInFlight.delete(id);
            });

        conversationFetchInFlight.set(id, request);
        return request;
    };

    const handleMessageNew = async (dto: unknown) => {
        if (!isMessageDTO(dto)) {
            console.error("Invalid MESSAGE_NEW payload:", dto);
            return;
        }

        const uiMessage = convertDTOToUI(dto);
        const conversationId = String(uiMessage.conversationId);
        const hasConversation = useChatStore
            .getState()
            .conversations
            .some((conversation) => String(conversation._id) === conversationId);

        if (!hasConversation) {
            await fetchConversationById(conversationId);
        }

        useChatStore.getState().receiveMessage(uiMessage);
    };

    const handleConversationCreated = async (payload: { conversationId?: string }) => {
        const conversationId = String(payload?.conversationId || "").trim();
        if (!conversationId) return;

        await fetchConversationById(conversationId);
    };

    const handleMessageDelete = (payload: { messageId: string; conversationId: string }) => {
        console.log("🔌 MESSAGE_DELETE", payload);
        // Handle minimal payload: mark message as deleted locally
        // Socket server is stateless; client manages message state
        const { messageId, conversationId } = payload;
        useChatStore.getState().updateDeletedMessage({
            _id: messageId,
            conversationId,
            content: "This message was deleted",
            isDeleted: true,
        } as any);
    };

    const handleMessageReaction = (dto: unknown) => {
        if (!isMessageDTO(dto)) return;

        const uiMessage = convertDTOToUI(dto);
        useChatStore.getState().updateMessage(uiMessage);
    };

    socket.on(SocketEvents.MESSAGE_NEW, handleMessageNew);
    socket.on(SocketEvents.CONVERSATION_CREATED, handleConversationCreated);
    socket.on(SocketEvents.MESSAGE_DELETE, handleMessageDelete);
    socket.on(SocketEvents.MESSAGE_REACTION, handleMessageReaction);

    registeredHandlers.set(SocketEvents.MESSAGE_NEW, handleMessageNew);
    registeredHandlers.set(SocketEvents.CONVERSATION_CREATED, handleConversationCreated);
    registeredHandlers.set(SocketEvents.MESSAGE_DELETE, handleMessageDelete);
    registeredHandlers.set(SocketEvents.MESSAGE_REACTION, handleMessageReaction);

    registerTaskSocketListeners(socket);

    const typingKey = (payload: TypingPayload) =>
        `${String(payload.conversationId)}:${String(payload.userId)}`;

    const clearTypingTimer = (key: string) => {
        const timer = typingExpiryTimers.get(key);
        if (!timer) return;
        clearTimeout(timer);
        typingExpiryTimers.delete(key);
    };

    const handleTypingStart = (payload: TypingPayload) => {
        if (!payload?.conversationId || !payload?.userId) return;

        useChatStore.getState().setTyping(payload.conversationId, payload.userId, true);

        const key = typingKey(payload);
        clearTypingTimer(key);

        const timer = setTimeout(() => {
            useChatStore
                .getState()
                .setTyping(payload.conversationId, payload.userId, false);
            typingExpiryTimers.delete(key);
        }, 4500);

        typingExpiryTimers.set(key, timer);
    };

    const handleTypingStop = (payload: TypingPayload) => {
        if (!payload?.conversationId || !payload?.userId) return;

        useChatStore.getState().setTyping(payload.conversationId, payload.userId, false);
        clearTypingTimer(typingKey(payload));
    };

    socket.on(SocketEvents.TYPING_START, handleTypingStart);
    socket.on(SocketEvents.TYPING_STOP, handleTypingStop);

    registeredHandlers.set(SocketEvents.TYPING_START, handleTypingStart);
    registeredHandlers.set(SocketEvents.TYPING_STOP, handleTypingStop);
}

export function clearGlobalSocketListeners() {
    for (const [event, handler] of registeredHandlers.entries()) {
        socket.off(event as any, handler as any);
    }

    registeredHandlers.clear();
    listenersRegistered = false;
}

function convertDTOToUI(dto: MessageDTO): UIMessage {
    if (!dto.sender || !dto.sender._id) {
        throw new Error("Invalid DTO: missing sender");
    }

    const status: UIMessage["status"] = dto.seen || (dto.seenBy?.length ?? 0) > 0
        ? "seen"
        : dto.delivered || (dto.deliveredTo?.length ?? 0) > 0
            ? "delivered"
            : "sent";

    return {
        ...dto,
        createdAt: new Date(dto.createdAt),
        updatedAt: dto.updatedAt ? new Date(dto.updatedAt) : undefined,
        status,
        isTemp: false,
    };
}