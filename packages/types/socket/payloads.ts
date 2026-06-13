import type { MessageAiStatus, MessageSemanticType, TaskExecutionActionType, TaskLinkType, TaskPriority, TaskRecord, TaskStatus } from "../task/task";

export interface JoinConversationPayload {
    conversationId: string;
}

export interface LeaveConversationPayload {
    conversationId: string;
}

export interface SendMessagePayload {
    conversationId: string;
    tempId: string;
    content: string;
    type: "text" | "image" | "video" | "audio" | "voice" | "file";
    fileUrl?: string;
    repliedTo?: string | null;
}

export interface EditMessagePayload {
    messageId: string;
    content: string;
}

export interface DeleteMessagePayload {
    messageId: string;
}

export interface ReactMessagePayload {
    messageId: string;
    emoji: string;
}

export interface MessageDeletedPayload {
    messageId: string;
    conversationId: string;
}

export interface TypingUpdatePayload {
    conversationId: string;
    userId: string;
    isTyping: boolean;
}

export interface PresenceUpdatePayload {
    userId: string;
    status: "online" | "offline";
}

export interface MessageSendAckPayload {
    tempId: string;
    realId: string;
}

export interface MessageFailedPayload {
    tempId: string;
    reason: string;
}

export interface MessageRetryPayload {
    tempId: string;
    conversationId: string;
}

export interface MessageDeliveredPayload {
    messageId: string;
    conversationId: string;
    senderId?: string;
    at?: Date | string;
}

export interface MessageDeliveredUpdatePayload {
    messageId: string;
    conversationId: string;
    userId: string;
    deliveredAt: Date | string;
}

export interface MessageSeenPayload {
    conversationId: string;
    messageIds: string[];
    at?: Date | string;
}

export interface MessageSeenUpdatePayload {
    conversationId: string;
    messageIds: string[];
    userId: string;
    seenAt: Date | string;
}

export interface MessageEditPayload {
    messageId: string;
    text: string;
    conversationId: string;
}

export interface MessageDeletePayload {
    messageId: string;
    conversationId: string;
}

export interface MessageUnsendPayload {
    messageId: string;
}

export interface MessageReactionPayload {
    messageId: string;
    emoji: string;
}

export interface TypingPayload {
    conversationId: string;
    userId: string;
    conversationMembers?: string[];
    name?: string;
    avatar?: string;
}

export interface UserOnlinePayload {
    userId: string;
}

export interface UserOfflinePayload {
    userId: string;
    lastSeen: Date;
}

export interface UserIdlePayload {
    userId: string;
}

export interface UserActivePayload {
    userId: string;
}

export interface PresencePingPayload {
    at?: Date | string;
}

export type CallType = "video" | "audio";

export type CallState =
    | "initiated"
    | "ringing"
    | "accepted"
    | "active"
    | "reconnecting"
    | "ended"
    | "rejected"
    | "missed"
    | "failed";

export type CallEndReason = "hangup" | "disconnect" | "error";

export type CallRejectReason = "declined" | "busy" | "timeout";

export interface CallParticipant {
    userId: string;
    deviceId?: string;
    acceptedAt?: Date | string;
}

export interface CallOfferInitPayload {
    callId: string;
    conversationId: string;
    from: string;
    to: string;
    callType: CallType;
    clientTs?: Date | string;
    deviceId?: string;
}

export interface CallOfferPayload {
    callId?: string;
    from: string;
    to: string;
    conversationId?: string;
    offer: RTCSessionDescriptionInit;
    sdpRevision?: number;
    deviceId?: string;
}

export interface CallAnswerPayload {
    callId?: string;
    from: string;
    to: string;
    answer: RTCSessionDescriptionInit;
    sdpRevision?: number;
    deviceId?: string;
}

export interface CallIceCandidatePayload {
    callId?: string;
    from: string;
    to: string;
    candidate: RTCIceCandidateInit;
    candidateSeq?: number;
    mid?: string | null;
    mLineIndex?: number | null;
}

export interface CallRingingPayload {
    callId?: string;
    conversationId?: string;
    from: string;
    to: string;
    expiresAt?: Date | string;
}

export interface CallAcceptPayload {
    callId: string;
    conversationId: string;
    from: string;
    to: string;
    acceptedAt?: Date | string;
    deviceId?: string;
}

export interface CallRejectPayload {
    callId: string;
    conversationId: string;
    from: string;
    to: string;
    reason: CallRejectReason;
}

export interface CallEndPayload {
    callId?: string;
    from: string;
    to: string;
    reason?: CallEndReason;
    endedAt?: Date | string;
}

export interface CallReconnectPayload {
    callId?: string;
    from: string;
    to: string;
    lastSeenSeq?: number;
    iceRestartRequired?: boolean;
}

export interface CallStatePayload {
    callId: string;
    conversationId?: string;
    status: CallState;
    participants: CallParticipant[];
    serverTs: Date | string;
}

export interface ConversationJoinPayload {
    conversationId: string;
}

export interface ConversationLeavePayload {
    conversationId: string;
}

export interface ConversationJoinedPayload {
    conversationId: string;
    userId: string;
    at: Date;
}

export interface ConversationLeftPayload {
    conversationId: string;
    userId: string;
    at: Date;
}

export interface ConversationUpdatedPayload {
    conversationId: string;
    changes: {
        name?: string;
        image?: string;
        members?: string[];
    };
}

export interface ConversationCreatedPayload {
    conversationId: string;
}

export interface SyncMessagesPayload {
    conversationId: string;
    since: Date;
}

export interface SyncConversationsPayload {
    userId: string;
}

export interface SyncStatusPayload {
    userId: string;
}

export interface SocketErrorPayload {
    type: string;
    message?: string;
    data?: unknown;
}

export interface DashboardInitPayload {
    activeUsers: number;
    totalMessagesToday: number;
}

export interface DashboardUpdatePayload {
    activeUsers?: number;
    totalMessagesToday?: number;
}

export interface TaskCreatedPayload {
    task: TaskRecord;
    sourceMessageId: string | null;
    createdByType: "user" | "agent" | "system";
}

export interface TaskUpdatedPayload {
    taskId: string;
    conversationId: string;
    patch: Partial<Pick<TaskRecord, "title" | "description" | "status" | "priority" | "assignees" | "dueAt" | "tags" | "latestContextMessageId" | "updatedBy" | "result" | "retryCount" | "maxRetries" | "parentTaskId" | "subTasks" | "dependencyIds" | "progress" | "checkpoints" | "executionHistory">>;
    previousVersion: number;
    newVersion: number;
    updatedByType: "user" | "agent" | "system";
    updatedById: string | null;
}

export interface TaskLinkedToMessagePayload {
    taskId: string;
    messageId: string;
    conversationId: string;
    linkType: TaskLinkType;
    taskVersion: number;
}

export interface TaskExecutionUpdatedPayload {
    taskId: string;
    conversationId: string;
    state: "queued" | "running" | "succeeded" | "failed" | "blocked" | "approval_pending";
    actionType: TaskExecutionActionType;
    summary: string | null;
    error: string | null;
    updatedAt: Date | string;
    runId?: string | null;
    sequence?: number;
    phase?: "intake" | "policy" | "reason" | "tool_execute" | "observe" | "verify" | "finalize" | "retry";
    step?: string | null;
    progress?: number;
    attempt?: number;
    details?: {
        reasoning?: string | null;
        toolName?: string | null;
        toolInput?: Record<string, unknown> | null;
        toolOutput?: unknown;
        verification?: {
            success: boolean;
            confidence: number;
        } | null;
    } | null;
    structuredOutput?: {
        status: "completed" | "partial" | "failed";
        confidence: number;
        summary: string;
        error: string | null;
        evidence: unknown;
    } | null;
}

export interface MessageSemanticUpdatedPayload {
    messageId: string;
    conversationId: string;
    semanticType: MessageSemanticType;
    semanticConfidence: number;
    aiStatus: MessageAiStatus;
    aiVersion: string | null;
    linkedTaskIds: string[];
    semanticProcessedAt: Date | string;
}