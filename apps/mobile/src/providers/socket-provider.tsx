import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AppState, type AppStateStatus } from "react-native";
import type { Socket } from "socket.io-client";
import { SocketEvents } from "@chat/types";

import { useAuthStore } from "@/features/auth/store/authStore";
import { usePresenceStore } from "@/store/presence-store";
import { socketClient } from "@/lib/socket";

const PRESENCE_HEARTBEAT_MS = 4_000;

type SocketContextValue = {
    socket: Socket | null;
    connected: boolean;
    connecting: boolean;
    connect: () => Promise<Socket | null>;
    disconnect: () => void;
    emit: typeof socketClient.emit;
    on: typeof socketClient.on;
    off: typeof socketClient.off;
};

const SocketContext = createContext<SocketContextValue | null>(null);

export function SocketProvider({ children }: { children: ReactNode }) {
    const user = useAuthStore((state) => state.user);
    const socketRef = useRef<Socket | null>(null);
    const appStateRef = useRef<AppStateStatus>(AppState.currentState);
    const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const [socket, setSocket] = useState<Socket | null>(null);
    const [connected, setConnected] = useState(false);
    const [connecting, setConnecting] = useState(false);
    const setOnlineUser = usePresenceStore((state) => state.setOnlineUser);
    const setOfflineUser = usePresenceStore((state) => state.setOfflineUser);
    const resetPresence = usePresenceStore((state) => state.resetPresence);

    const stopHeartbeat = () => {
        if (!heartbeatRef.current) {
            return;
        }

        clearInterval(heartbeatRef.current);
        heartbeatRef.current = null;
    };

    const startHeartbeat = () => {
        stopHeartbeat();

        const currentSocket = socketRef.current;

        if (!currentSocket?.connected) {
            return;
        }

        const sendPing = () => {
            if (!socketRef.current?.connected) {
                return;
            }

            socketRef.current.emit(SocketEvents.PRESENCE_PING, { at: new Date().toISOString() });
        };

        sendPing();
        heartbeatRef.current = setInterval(sendPing, PRESENCE_HEARTBEAT_MS);
    };

    useEffect(() => {
        const currentSocket = socketClient.getSocket();
        socketRef.current = currentSocket;
        setSocket(currentSocket);

        const handleConnect = () => {
            setConnected(true);
            setConnecting(false);
            startHeartbeat();
        };

        const handleDisconnect = () => {
            stopHeartbeat();
            setConnected(false);
            setConnecting(false);
        };

        const handleConnectError = (error: unknown) => {
            const message =
                typeof error === "object" && error && "message" in error
                    ? String((error as { message?: unknown }).message ?? "")
                    : "";

            if (message.toLowerCase().includes("unauthorized")) {
                socketClient.disconnect();
                setConnected(false);
            }

            setConnecting(false);
        };

        const handleUserOnline = (payload: unknown) => {
            const value = payload as { userId?: unknown };
            const userId = typeof value.userId === "string" ? value.userId : null;

            if (!userId) {
                return;
            }

            setOnlineUser(userId);
        };

        const handleUserOffline = (payload: unknown) => {
            const value = payload as { userId?: unknown; lastSeen?: unknown };
            const userId = typeof value.userId === "string" ? value.userId : null;

            if (!userId) {
                return;
            }

            setOfflineUser(userId, value.lastSeen instanceof Date || typeof value.lastSeen === "string" ? value.lastSeen : undefined);
        };

        currentSocket.on("connect", handleConnect);
        currentSocket.on("disconnect", handleDisconnect);
        currentSocket.on("connect_error", handleConnectError);
        currentSocket.on(SocketEvents.USER_ONLINE, handleUserOnline);
        currentSocket.on(SocketEvents.USER_OFFLINE, handleUserOffline);

        const subscription = AppState.addEventListener("change", (nextState) => {
            appStateRef.current = nextState;

            if (nextState !== "active") {
                // Do not disconnect on background: that broadcast USER_OFFLINE to peers
                // while the user is still using the app (other tab / return soon). OS may
                // still suspend the socket; reconnect path runs when active again.
                return;
            }

            if (useAuthStore.getState().user) {
                setConnecting(true);
                void socketClient.connect()
                    .then(() => {
                        startHeartbeat();
                    })
                    .finally(() => {
                        setConnecting(false);
                    });
            }
        });

        return () => {
            stopHeartbeat();
            subscription.remove();
            currentSocket.off("connect", handleConnect);
            currentSocket.off("disconnect", handleDisconnect);
            currentSocket.off("connect_error", handleConnectError);
            currentSocket.off(SocketEvents.USER_ONLINE, handleUserOnline);
            currentSocket.off(SocketEvents.USER_OFFLINE, handleUserOffline);
        };
    }, []);

    useEffect(() => {
        let cancelled = false;

        const syncSocket = async () => {
            if (!user) {
                socketClient.disconnect();
                resetPresence();
                if (!cancelled) {
                    setConnected(false);
                    setConnecting(false);
                }

                return;
            }

            if (appStateRef.current !== "active") {
                return;
            }

            setConnecting(true);

            try {
                await socketClient.connect();
                if (!cancelled) {
                    setConnected(Boolean(socketRef.current?.connected));
                }

                startHeartbeat();
            } finally {
                if (!cancelled) {
                    setConnecting(false);
                }
            }
        };

        void syncSocket();

        return () => {
            cancelled = true;
            stopHeartbeat();
        };
    }, [user]);

    const value = useMemo<SocketContextValue>(
        () => ({
            socket,
            connected,
            connecting,
            connect: socketClient.connect.bind(socketClient),
            disconnect: socketClient.disconnect.bind(socketClient),
            emit: socketClient.emit.bind(socketClient),
            on: socketClient.on.bind(socketClient),
            off: socketClient.off.bind(socketClient),
        }),
        [connected, connecting, socket]
    );

    return <SocketContext.Provider value={value}>{children}</SocketContext.Provider>;
}

export function useSocket() {
    const context = useContext(SocketContext);

    if (!context) {
        throw new Error("useSocket must be used within SocketProvider");
    }

    return context;
}