'use client';

import { useEffect } from "react";
import { socket, registerGlobalSocketListeners, clearGlobalSocketListeners } from "@/lib/socket/socketClient";
import { useUser } from "@/context/UserContext";
import { useSocketPresence } from "@/lib/hooks/useSocketPresence";
import { useNetworkStatus } from "@/lib/hooks/useNetworkStatus";
import { recordSocketTiming, markStart, markEnd } from "@/lib/utils/performance";

const isTabVisible = () =>
    typeof document === "undefined" || document.visibilityState === "visible";

/**
 * Deferred socket initialization
 * Connect and register listeners after initial render using requestIdleCallback
 * This prevents blocking the initial paint
 */
function initializeSocketInBackground() {
    if (typeof window === 'undefined') return;

    if (socket.connected) {
        registerGlobalSocketListeners();
        return;
    }

    const idleCallback = () => {
        markStart('socket:connect');

        const connectStartedAt = performance.now();
        socket.auth = {};
        registerGlobalSocketListeners();

        const connectHandler = () => {
            recordSocketTiming(performance.now() - connectStartedAt);
            markEnd('socket:connect');
            socket.off('connect', connectHandler);
        };

        socket.once('connect', connectHandler);
        socket.connect();
    };

    // Use requestIdleCallback if available, fallback to setTimeout
    if ('requestIdleCallback' in window) {
        requestIdleCallback(idleCallback, { timeout: 2000 });
    } else {
        // Fallback: defer to next frame + small delay to ensure initial render completes
        requestAnimationFrame(() => {
            setTimeout(idleCallback, 0);
        });
    }
}

export function SocketProvider({ children }: { children: React.ReactNode }) {
    const { user } = useUser();
    const isOnline = useNetworkStatus();
    useSocketPresence(user?._id ?? null);

    // Initialize socket in background, non-blocking
    useEffect(() => {
        if (!user?._id) return;

        initializeSocketInBackground();

        return () => {
            socket.disconnect();
            clearGlobalSocketListeners();
        };
    }, [user?._id]);

    // Connection resilience - ensure socket stays connected
    useEffect(() => {
        if (!user?._id) return;

        const ensureConnected = () => {
            if (!isOnline) return;
            if (!isTabVisible()) return;
            if (!socket.connected) {
                socket.connect();
            }
        };

        const handleDisconnect = (reason: string) => {
            if (reason === "io server disconnect") {
                setTimeout(ensureConnected, 1200);
            }
        };

        const handleConnectError = () => {
            setTimeout(ensureConnected, 1500);
        };

        if (isOnline && !socket.connected) {
            ensureConnected();
        }

        const reconnectInterval = setInterval(() => {
            ensureConnected();
        }, 5000);

        socket.on("disconnect", handleDisconnect);
        socket.on("connect_error", handleConnectError);

        return () => {
            clearInterval(reconnectInterval);
            socket.off("disconnect", handleDisconnect);
            socket.off("connect_error", handleConnectError);
        };
    }, [user?._id, isOnline]);

    // Visibility-based connection management
    useEffect(() => {
        if (!user?._id) return;

        const disconnectNow = () => {
            if (socket.connected) {
                socket.disconnect();
            }
        };

        const reconnectNow = () => {
            if (!isOnline) return;
            if (!socket.connected) {
                socket.connect();
            }
        };

        const handleVisibilityChange = () => {
            if (document.visibilityState === "hidden") {
                disconnectNow();
                return;
            }
            reconnectNow();
        };

        const handlePageHide = () => {
            disconnectNow();
        };

        document.addEventListener("visibilitychange", handleVisibilityChange);
        window.addEventListener("pagehide", handlePageHide);
        window.addEventListener("beforeunload", handlePageHide);

        handleVisibilityChange();

        return () => {
            document.removeEventListener("visibilitychange", handleVisibilityChange);
            window.removeEventListener("pagehide", handlePageHide);
            window.removeEventListener("beforeunload", handlePageHide);
        };
    }, [user?._id, isOnline]);

    return children;
}