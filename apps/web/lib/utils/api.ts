import type { ClientConversation, ClientUser, UIMessage } from "@chat/types";
import {
    isStepUpResponse,
    parseAuthPayload,
    redirectToLogin,
    redirectToStepUpChallenge,
    refreshSession,
} from "@/lib/utils/auth/client-session";
import { ensureAuthReady } from "@/lib/auth/authBootstrap";

type ApiErrorPayload = {
    error?: string;
    code?: string;
    requiresReauth?: boolean;
    challengeId?: string;
};

export type AdminAuthEventType = "LOGIN" | "REFRESH" | "REVOKE" | "STEP_UP";

export type AdminAuthEvent = {
    id: string;
    eventType: AdminAuthEventType;
    eventName: string;
    outcome: "success" | "failure";
    userId: string | null;
    timestamp: string;
    ipAddress: string;
    userAgent: string;
    reason?: string;
};

export type AdminAuthEventsResponse = {
    events: AdminAuthEvent[];
    pagination: {
        page: number;
        limit: number;
        total: number;
        totalPages: number;
    };
};

export type TaskApprovalRecord = {
    _id: string;
    taskId: string;
    conversationId: string;
    actorType: "user" | "agent" | "system";
    actorId: string | null;
    actionType: string;
    messageId: string | null;
    parameters: Record<string, unknown>;
    executionState: string | null;
    summary: string | null;
    error: string | null;
    patch: {
        before: unknown | null;
        after: unknown | null;
    };
    reason: string;
    idempotencyKey: string;
    createdAt: string;
};

export type TaskApprovalsResponse = {
    approvals: TaskApprovalRecord[];
};

function wait(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function authenticatedFetch(
    url: string,
    init?: RequestInit,
    hasRetried = false
): Promise<Response> {
    // Ensure auth bootstrap completes before attempting protected requests
    // Skip waiting for the refresh endpoint itself to avoid deadlocks
    if (url !== "/api/auth/refresh") {
        try {
            await ensureAuthReady();
        } catch (err) {
            console.warn("authenticatedFetch: ensureAuthReady failed", err);
        }
    }
    const response = await fetch(url, {
        ...init,
        credentials: "include",
        headers: {
            "Content-Type": "application/json",
            ...(init?.headers || {}),
        },
    });

    const responseClone = response.clone();
    const rawText = await responseClone.text();
    const payload = parseAuthPayload(rawText) as ApiErrorPayload | null;

    if (response.ok) {
        return response;
    }

    if (isStepUpResponse(payload)) {
        redirectToStepUpChallenge(payload?.challengeId);
    }

    if (response.status === 401 && !hasRetried && url !== "/api/auth/refresh") {
        const refreshed = await refreshSession();

        if (refreshed.ok) {
            return authenticatedFetch(url, init, true);
        }

        if (refreshed.ok === false && refreshed.reason === "transient") {
            await wait(250);
            const retriedRefresh = await refreshSession();
            if (retriedRefresh.ok) {
                return authenticatedFetch(url, init, true);
            }

            if (retriedRefresh.ok === false && retriedRefresh.reason === "unauthorized") {
                redirectToLogin();
            }
        }

        if (refreshed.ok === false && refreshed.reason === "unauthorized") {
            redirectToLogin();
        }
    }

    return response;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
    const response = await authenticatedFetch(url, init);

    const rawText = await response.text();
    const payload = parseAuthPayload(rawText) as ApiErrorPayload | null;

    if (!response.ok) {
        throw new Error(payload?.error || rawText || `Request failed with status ${response.status}`);
    }

    if (response.status === 204 || !rawText) {
        return undefined as T;
    }

    return JSON.parse(rawText) as T;
}

export async function getMe(): Promise<ClientUser> {
    return request<ClientUser>("/api/me");
}

export async function getUsers(): Promise<ClientUser[]> {
    return request<ClientUser[]>("/api/users");
}

export async function getConversations(): Promise<ClientConversation[]> {
    return request<ClientConversation[]>("/api/conversations");
}

export async function createConversation(payload: {
    participants: string[];
    isGroup: boolean;
    admin?: string;
    groupName?: string;
    image?: string;
}): Promise<string> {
    const data = await request<{ _id?: string; id?: string } | string>("/api/conversations", {
        method: "POST",
        body: JSON.stringify(payload),
    });

    if (typeof data === "string") return data;
    return String(data._id || data.id || "");
}

export async function toggleBan(id: string, status: "active" | "banned") {
    return request<{ success: boolean }>("/api/admin/toggleban", {
        method: "PATCH",
        body: JSON.stringify({ id, status }),
    });
}

export async function changePermission(id: string, role: "user" | "moderator" | "admin") {
    return request<{ userrole: string }>("/api/admin/changeRoal", {
        method: "PATCH",
        body: JSON.stringify({ id, role }),
    });
}

export async function deleteMessage(messageId: string) {
    return request<{ success: boolean }>(`/api/messages/${messageId}/delete`, {
        method: "DELETE",
    });
}

export async function reactToMessage(message: UIMessage, emoji: string) {
    const id = typeof message._id === "string" ? message._id : String(message._id);
    return request<{ success: boolean }>(`/api/messages/${id}/react`, {
        method: "POST",
        body: JSON.stringify({ emoji }),
    });
}

export async function getAdminAuthEvents(params?: {
    page?: number;
    limit?: number;
    eventType?: AdminAuthEventType;
    userId?: string;
    date?: string;
}): Promise<AdminAuthEventsResponse> {
    const searchParams = new URLSearchParams();

    if (params?.page) searchParams.set("page", String(params.page));
    if (params?.limit) searchParams.set("limit", String(params.limit));
    if (params?.eventType) searchParams.set("eventType", params.eventType);
    if (params?.userId) searchParams.set("userId", params.userId);
    if (params?.date) searchParams.set("date", params.date);

    const query = searchParams.toString();
    const data = await request<{ success: boolean; data: AdminAuthEventsResponse }>(
        `/api/admin/auth-events${query ? `?${query}` : ""}`
    );

    return data.data;
}

export async function getTaskApprovals(conversationId?: string): Promise<TaskApprovalsResponse> {
    const query = conversationId ? `?conversationId=${encodeURIComponent(conversationId)}` : "";
    return request<TaskApprovalsResponse>(`/api/task-approvals${query}`);
}

export async function decideTaskApproval(input: {
    taskActionId: string;
    decision: "approve" | "reject";
    reason?: string;
    reviewerComment?: string;
    parameters?: Record<string, unknown>;
}): Promise<{ approval: TaskApprovalRecord | null }> {
    return request<{ approval: TaskApprovalRecord | null }>("/api/task-approvals", {
        method: "POST",
        body: JSON.stringify(input),
    });
}
