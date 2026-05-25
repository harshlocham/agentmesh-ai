import type { MessageDTO } from "../dto/message.dto";
import type {
    CallAcceptPayload,
    CallAnswerPayload,
    CallEndPayload,
    CallIceCandidatePayload,
    CallOfferInitPayload,
    CallOfferPayload,
    CallRejectPayload,
    CallReconnectPayload,
    CallRingingPayload,
    CallStatePayload,
    ConversationJoinPayload,
    ConversationCreatedPayload,
    ConversationJoinedPayload,
    ConversationLeavePayload,
    ConversationLeftPayload,
    ConversationUpdatedPayload,
    DashboardInitPayload,
    DashboardUpdatePayload,
    MessageSemanticUpdatedPayload,
    MessageDeletePayload,
    MessageDeliveredPayload,
    MessageDeliveredUpdatePayload,
    MessageEditPayload,
    MessageFailedPayload,
    MessageReactionPayload,
    MessageRetryPayload,
    MessageSeenPayload,
    MessageSeenUpdatePayload,
    MessageSendAckPayload,
    MessageUnsendPayload,
    PresencePingPayload,
    SocketErrorPayload,
    SyncConversationsPayload,
    SyncMessagesPayload,
    SyncStatusPayload,
    TaskCreatedPayload,
    TaskExecutionUpdatedPayload,
    TaskLinkedToMessagePayload,
    TaskUpdatedPayload,
    TypingPayload,
    UserActivePayload,
    UserIdlePayload,
    UserOfflinePayload,
    UserOnlinePayload,
} from "./payloads";

export const SocketEvents = {
    MESSAGE_NEW: "message:new",
    MESSAGE_SEND: "message:send",
    MESSAGE_SEND_ACK: "message:send:ack",
    MESSAGE_FAILED: "message:failed",
    MESSAGE_RETRY: "message:retry",
    MESSAGE_DELIVERED: "message:delivered",
    MESSAGE_DELIVERED_UPDATE: "message:delivered:update",
    MESSAGE_SEEN: "message:seen",
    MESSAGE_SEEN_UPDATE: "message:seen:update",
    MESSAGE_EDIT: "message:edit",
    MESSAGE_EDITED: "message:edited",
    MESSAGE_DELETE: "message:delete",
    MESSAGE_UNSEND: "message:unsend",
    MESSAGE_REACTION: "message:reaction",
    TASK_CREATED: "task:created",
    TASK_UPDATED: "task:updated",
    TASK_LINKED_TO_MESSAGE: "task:linked_to_message",
    TASK_EXECUTION_UPDATED: "task:execution_updated",
    MESSAGE_SEMANTIC_UPDATED: "message:semantic_updated",
    TYPING_START: "typing:start",
    TYPING_STOP: "typing:stop",
    USER_ONLINE: "user:online",
    USER_OFFLINE: "user:offline",
    PRESENCE_PING: "presence:ping",
    USER_IDLE: "user:idle",
    USER_ACTIVE: "user:active",
    CALL_OFFER: "call:offer",
    CALL_OFFER_INIT: "call:offer:init",
    CALL_ANSWER: "call:answer",
    CALL_ICE_CANDIDATE: "call:ice-candidate",
    CALL_RINGING: "call:ringing",
    CALL_ACCEPT: "call:accept",
    CALL_REJECT: "call:reject",
    CALL_BUSY: "call:busy",
    CALL_END: "call:end",
    CALL_RECONNECT: "call:reconnect",
    CALL_STATE: "call:state",
    CONVERSATION_JOIN: "conversation:join",
    CONVERSATION_LEAVE: "conversation:leave",
    CONVERSATION_JOINED: "conversation:joined",
    CONVERSATION_LEFT: "conversation:left",
    CONVERSATION_CREATED: "conversation:created",
    CONVERSATION_UPDATED: "conversation:updated",
    SYNC_MESSAGES: "sync:messages",
    SYNC_CONVERSATIONS: "sync:conversations",
    SYNC_STATUS: "sync:status",
    ERROR_GENERIC: "error:generic",
    ERROR_MESSAGE: "error:message",
    ERROR_CALL: "error:call",
    ERROR_AUTH: "error:auth",
    ADMIN_JOIN: "admin:join",
    DASHBOARD_INIT: "dashboard:init",
    DASHBOARD_UPDATE: "dashboard:update",
} as const;

export type SocketEventName = (typeof SocketEvents)[keyof typeof SocketEvents];
export type ValueOf<T> = T[keyof T];

// SERVER → CLIENT MAP

export interface ServerToClientEvents {
    // Messages
    [SocketEvents.MESSAGE_NEW]: (data: MessageDTO) => void;
    [SocketEvents.MESSAGE_SEND_ACK]: (data: MessageSendAckPayload) => void;
    [SocketEvents.MESSAGE_FAILED]: (data: MessageFailedPayload) => void;
    [SocketEvents.MESSAGE_DELIVERED_UPDATE]: (data: MessageDeliveredUpdatePayload) => void;
    [SocketEvents.MESSAGE_SEEN_UPDATE]: (data: MessageSeenUpdatePayload) => void;
    [SocketEvents.MESSAGE_EDIT]: (data: MessageEditPayload) => void;
    [SocketEvents.MESSAGE_EDITED]: (data: MessageEditPayload) => void;
    [SocketEvents.MESSAGE_DELETE]: (data: MessageDeletePayload) => void;
    [SocketEvents.MESSAGE_UNSEND]: (data: MessageUnsendPayload) => void;
    [SocketEvents.MESSAGE_REACTION]: (data: MessageReactionPayload) => void;

    [SocketEvents.TASK_CREATED]: (data: TaskCreatedPayload) => void;
    [SocketEvents.TASK_UPDATED]: (data: TaskUpdatedPayload) => void;
    [SocketEvents.TASK_LINKED_TO_MESSAGE]: (data: TaskLinkedToMessagePayload) => void;
    [SocketEvents.TASK_EXECUTION_UPDATED]: (data: TaskExecutionUpdatedPayload) => void;
    [SocketEvents.MESSAGE_SEMANTIC_UPDATED]: (data: MessageSemanticUpdatedPayload) => void;

    // Typing
    [SocketEvents.TYPING_START]: (data: TypingPayload) => void;
    [SocketEvents.TYPING_STOP]: (data: TypingPayload) => void;

    // Presence
    [SocketEvents.USER_ONLINE]: (data: UserOnlinePayload) => void;
    [SocketEvents.USER_OFFLINE]: (data: UserOfflinePayload) => void;
    [SocketEvents.USER_IDLE]: (data: UserIdlePayload) => void;
    [SocketEvents.USER_ACTIVE]: (data: UserActivePayload) => void;

    // Call
    [SocketEvents.CALL_OFFER]: (data: CallOfferPayload) => void;
    [SocketEvents.CALL_OFFER_INIT]: (data: CallOfferInitPayload) => void;
    [SocketEvents.CALL_ANSWER]: (data: CallAnswerPayload) => void;
    [SocketEvents.CALL_ICE_CANDIDATE]: (data: CallIceCandidatePayload) => void;
    [SocketEvents.CALL_RINGING]: (data: CallRingingPayload) => void;
    [SocketEvents.CALL_ACCEPT]: (data: CallAcceptPayload) => void;
    [SocketEvents.CALL_REJECT]: (data: CallRejectPayload) => void;
    [SocketEvents.CALL_BUSY]: (data: CallRingingPayload) => void;
    [SocketEvents.CALL_RECONNECT]: (data: CallReconnectPayload) => void;
    [SocketEvents.CALL_END]: (data: CallEndPayload) => void;
    [SocketEvents.CALL_STATE]: (data: CallStatePayload) => void;

    // Conversation
    [SocketEvents.CONVERSATION_JOINED]: (data: ConversationJoinedPayload) => void;
    [SocketEvents.CONVERSATION_LEFT]: (data: ConversationLeftPayload) => void;
    [SocketEvents.CONVERSATION_CREATED]: (data: ConversationCreatedPayload) => void;
    [SocketEvents.CONVERSATION_UPDATED]: (data: ConversationUpdatedPayload) => void;

    // Sync
    [SocketEvents.SYNC_MESSAGES]: (data: SyncMessagesPayload) => void;
    [SocketEvents.SYNC_CONVERSATIONS]: (data: SyncConversationsPayload) => void;
    [SocketEvents.SYNC_STATUS]: (data: SyncStatusPayload) => void;

    // Errors
    [SocketEvents.ERROR_GENERIC]: (data: SocketErrorPayload) => void;
    [SocketEvents.ERROR_MESSAGE]: (data: SocketErrorPayload) => void;
    [SocketEvents.ERROR_CALL]: (data: SocketErrorPayload) => void;
    [SocketEvents.ERROR_AUTH]: (data: SocketErrorPayload) => void;

    // Admin
    [SocketEvents.DASHBOARD_INIT]: (data: DashboardInitPayload) => void;
    [SocketEvents.DASHBOARD_UPDATE]: (data: DashboardUpdatePayload) => void;
}

// CLIENT → SERVER MAP

export interface ClientToServerEvents {
    // Messages
    [SocketEvents.MESSAGE_SEND]: (payload: {
        data: MessageDTO;
        conversationMembers: string[];
    }) => void;
    [SocketEvents.MESSAGE_NEW]: (data: MessageDTO) => void;
    [SocketEvents.MESSAGE_RETRY]: (data: MessageRetryPayload) => void;
    [SocketEvents.MESSAGE_DELIVERED]: (data: MessageDeliveredPayload) => void;
    [SocketEvents.MESSAGE_SEEN]: (data: MessageSeenPayload) => void;
    [SocketEvents.MESSAGE_EDIT]: (data: MessageEditPayload) => void;
    [SocketEvents.MESSAGE_DELETE]: (data: MessageDeletePayload) => void;
    [SocketEvents.MESSAGE_UNSEND]: (data: MessageUnsendPayload) => void;
    [SocketEvents.MESSAGE_REACTION]: (data: MessageReactionPayload) => void;

    // Typing
    [SocketEvents.TYPING_START]: (data: TypingPayload) => void;
    [SocketEvents.TYPING_STOP]: (data: TypingPayload) => void;

    // Presence
    [SocketEvents.PRESENCE_PING]: (data?: PresencePingPayload) => void;

    // Calls
    [SocketEvents.CALL_OFFER]: (data: CallOfferPayload) => void;
    [SocketEvents.CALL_OFFER_INIT]: (data: CallOfferInitPayload) => void;
    [SocketEvents.CALL_ANSWER]: (data: CallAnswerPayload) => void;
    [SocketEvents.CALL_ICE_CANDIDATE]: (data: CallIceCandidatePayload) => void;
    [SocketEvents.CALL_ACCEPT]: (data: CallAcceptPayload) => void;
    [SocketEvents.CALL_REJECT]: (data: CallRejectPayload) => void;
    [SocketEvents.CALL_END]: (data: CallEndPayload) => void;
    [SocketEvents.CALL_BUSY]: (data: CallRingingPayload) => void;
    [SocketEvents.CALL_RECONNECT]: (data: CallReconnectPayload) => void;

    // Conversation
    [SocketEvents.CONVERSATION_JOIN]: (data: ConversationJoinPayload) => void;
    [SocketEvents.CONVERSATION_LEAVE]: (data: ConversationLeavePayload) => void;

    // Sync
    [SocketEvents.SYNC_MESSAGES]: (data: SyncMessagesPayload) => void;

    // Error reporting (optional)
    [SocketEvents.ERROR_GENERIC]?: (data: SocketErrorPayload) => void;

    // Admin
    [SocketEvents.ADMIN_JOIN]: () => void;
}