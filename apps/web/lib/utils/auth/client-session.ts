type AuthErrorPayload = {
    error?: string;
    code?: string;
    requiresReauth?: boolean;
    challengeId?: string;
};

type RefreshBroadcastMessage = {
    type: "REFRESH_START" | "REFRESH_SUCCESS" | "REFRESH_FAILED";
    senderId: string;
};

const AUTH_CHANNEL_NAME = "auth";
const CROSS_TAB_WAIT_TIMEOUT_MS = 8000;

const tabId =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `tab-${Math.random().toString(36).slice(2)}`;

let channel: BroadcastChannel | null = null;
let channelInitialized = false;
let coordinationOwnerId: string | null = null;
const crossTabWaiters = new Set<(result: RefreshSessionResult) => void>();

declare global {
    interface Window {
        __authRefreshInFlight__?: Promise<RefreshSessionResult> | null;
    }
}

export function parseAuthPayload(rawText: string): AuthErrorPayload | null {
    if (!rawText) {
        return null;
    }

    try {
        return JSON.parse(rawText) as AuthErrorPayload;
    } catch {
        return null;
    }
}

export function isStepUpResponse(payload: AuthErrorPayload | null): boolean {
    return (
        payload?.code === "AUTH_STEP_UP_REQUIRED" ||
        payload?.requiresReauth === true ||
        payload?.error === "STEP_UP_REQUIRED"
    );
}

export function redirectToStepUpChallenge(challengeId?: string) {
    if (typeof window === "undefined") {
        return;
    }

    if (window.location.pathname.startsWith("/auth/challenge")) {
        return;
    }

    const params = new URLSearchParams();
    if (challengeId) {
        params.set("cid", challengeId);
    }

    const next = `${window.location.pathname}${window.location.search}`;
    params.set("next", next || "/");

    window.location.href = `/auth/challenge?${params.toString()}`;
}

export function redirectToLogin() {
    if (typeof window === "undefined") {
        return;
    }

    if (window.location.pathname === "/login") {
        return;
    }

    window.location.href = "/login";
}

export type RefreshSessionResult =
    | { ok: true }
    | { ok: false; reason: "unauthorized" | "step_up" | "transient" | "rate_limited" };

export class AuthSessionPendingError extends Error {
    readonly reason: "step_up" | "unauthenticated";

    constructor(reason: "step_up" | "unauthenticated", message = "Auth session pending") {
        super(message);
        this.name = "AuthSessionPendingError";
        this.reason = reason;
    }
}

export function isAuthSessionPendingError(error: unknown): error is AuthSessionPendingError {
    return error instanceof AuthSessionPendingError;
}

export function isPublicAuthRoute(pathname: string): boolean {
    return (
        pathname === "/login" ||
        pathname === "/register" ||
        pathname.startsWith("/auth/challenge")
    );
}

function canUseBroadcastChannel(): boolean {
    return typeof window !== "undefined" && typeof BroadcastChannel !== "undefined";
}

function resolveCrossTabWaiters(result: RefreshSessionResult) {
    for (const resolve of crossTabWaiters) {
        resolve(result);
    }
    crossTabWaiters.clear();
}

function initAuthChannel() {
    if (channelInitialized || !canUseBroadcastChannel()) {
        return;
    }

    channelInitialized = true;
    channel = new BroadcastChannel(AUTH_CHANNEL_NAME);
    channel.onmessage = (event: MessageEvent<RefreshBroadcastMessage>) => {
        const message = event.data;
        if (!message || message.senderId === tabId) {
            return;
        }

        if (message.type === "REFRESH_START") {
            // Deterministic owner election prevents two tabs from refreshing at once.
            if (!coordinationOwnerId || message.senderId < coordinationOwnerId) {
                coordinationOwnerId = message.senderId;
            }
            return;
        }

        coordinationOwnerId = null;

        if (message.type === "REFRESH_SUCCESS") {
            resolveCrossTabWaiters({ ok: true });
            return;
        }

        resolveCrossTabWaiters({ ok: false, reason: "transient" });
    };
}

function broadcastRefresh(message: RefreshBroadcastMessage) {
    if (!channel) {
        return;
    }

    channel.postMessage(message);
}

function waitForCrossTabRefresh(): Promise<RefreshSessionResult> {
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            crossTabWaiters.delete(handleResolve);
            coordinationOwnerId = null;
            resolve({ ok: false, reason: "transient" });
        }, CROSS_TAB_WAIT_TIMEOUT_MS);

        const handleResolve = (result: RefreshSessionResult) => {
            clearTimeout(timer);
            resolve(result);
        };

        crossTabWaiters.add(handleResolve);
    });
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRefreshPromise(): Promise<RefreshSessionResult> | null {
    if (typeof window === "undefined") {
        return null;
    }

    return window.__authRefreshInFlight__ ?? null;
}

function setRefreshPromise(promise: Promise<RefreshSessionResult> | null) {
    if (typeof window === "undefined") {
        return;
    }

    window.__authRefreshInFlight__ = promise;
}

export async function refreshSession(): Promise<RefreshSessionResult> {
    const existing = getRefreshPromise();
    if (existing) {
        return existing;
    }

    const inFlight = (async () => {
        initAuthChannel();

        if (coordinationOwnerId && coordinationOwnerId !== tabId) {
            return waitForCrossTabRefresh();
        }

        coordinationOwnerId = tabId;
        broadcastRefresh({ type: "REFRESH_START", senderId: tabId });

        // Small election window: if another tab with lower owner id announces start,
        // this tab waits instead of triggering a concurrent refresh.
        await sleep(30);
        if (coordinationOwnerId !== tabId) {
            return waitForCrossTabRefresh();
        }

        try {
            const response = await fetch("/api/auth/refresh", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                cache: "no-store",
                credentials: "include",
            });

            const rawText = await response.text();
            const payload = parseAuthPayload(rawText);

            if (response.ok) {
                broadcastRefresh({ type: "REFRESH_SUCCESS", senderId: tabId });
                return { ok: true } as const;
            }

            if (isStepUpResponse(payload)) {
                redirectToStepUpChallenge(payload?.challengeId);
                broadcastRefresh({ type: "REFRESH_FAILED", senderId: tabId });
                return { ok: false, reason: "step_up" } as const;
            }

            if (response.status === 401) {
                broadcastRefresh({ type: "REFRESH_FAILED", senderId: tabId });
                return { ok: false, reason: "unauthorized" } as const;
            }

            if (response.status === 429 || payload?.code === "AUTH_RATE_LIMITED") {
                broadcastRefresh({ type: "REFRESH_FAILED", senderId: tabId });
                return { ok: false, reason: "rate_limited" } as const;
            }

            broadcastRefresh({ type: "REFRESH_FAILED", senderId: tabId });
            return { ok: false, reason: "transient" } as const;
        } catch {
            broadcastRefresh({ type: "REFRESH_FAILED", senderId: tabId });
            return { ok: false, reason: "transient" } as const;
        } finally {
            if (coordinationOwnerId === tabId) {
                coordinationOwnerId = null;
            }
            setRefreshPromise(null);
        }
    })();

    setRefreshPromise(inFlight);
    return inFlight;
}
