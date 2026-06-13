export const PRESENCE_HEARTBEAT_TTL_SECONDS = 12;
export const MESSAGE_DELIVERY_TTL_SECONDS = 60 * 60 * 24 * 7;
export const CALL_RINGING_TTL_SECONDS = 45;
export const CALL_ACTIVE_TTL_SECONDS = 90;
export const CALL_TERMINAL_TTL_SECONDS = 60 * 10;
export const CALL_ACCEPT_LOCK_TTL_SECONDS = 20;

export const redisKeys = {
    onlineUser: (userId: string) => `online_users:${userId}`,
    userSockets: (userId: string) => `user_sockets:${userId}`,
    userActiveConversation: (userId: string) => `user_active_conversation:${userId}`,
    userActiveCall: (userId: string) => `user:${userId}:active_call`,
    userPresence: (userId: string) => `user_presence:${userId}`,
    messageDelivery: (messageId: string) => `message_delivery:${messageId}`,
    callState: (callId: string) => `call:${callId}:state`,
    callAcceptedBy: (callId: string) => `call:${callId}:accepted_by`,
    callParticipants: (callId: string) => `call:${callId}:participants`,
    callAcceptLock: (callId: string) => `call:${callId}:lock:accept`,
    callSeq: (callId: string, userId: string) => `call:${callId}:seq:${userId}`,
    activeUsersSet: "active_users",
};

export type MessageDeliveryState = "sent" | "delivered" | "seen";
