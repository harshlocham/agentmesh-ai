// context/UserContext.tsx
"use client";

import { ClientUser } from "@chat/types";
import { createContext, useContext, useMemo, useEffect, useRef, useState } from "react";
import { parseAuthPayload, isStepUpResponse, redirectToStepUpChallenge } from "@/lib/utils/auth/client-session";
import { recordApiTiming } from "@/lib/utils/performance";
import { getMe } from "@/lib/utils/api";
import { ensureAuthReady } from "@/lib/auth/authBootstrap";

type MeErrorPayload = {
    error?: string;
    code?: string;
    requiresReauth?: boolean;
    challengeId?: string;
};

function wait(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchCurrentUser(signal?: AbortSignal): Promise<ClientUser | null> {
    const startedAt = performance.now();

    // Ensure auth bootstrap runs first
    try {
        await ensureAuthReady();
    } catch (err) {
        console.warn("UserContext: ensureAuthReady failed", err);
    }

    try {
        const user = await getMe();
        recordApiTiming("/api/me", performance.now() - startedAt);
        return user || null;
    } catch (err) {
        recordApiTiming("/api/me", performance.now() - startedAt);
        console.error("Failed to load current user", err);
        return null;
    }
}

type UserContextType = {
    user: ClientUser | null;
    isLoading: boolean;
    usersById: Record<string, ClientUser>;
    error: Error | null;
    refreshUser: () => Promise<ClientUser | null | undefined>;
    isInitialized: boolean;
};

const UserContext = createContext<UserContextType>({
    user: null,
    usersById: {},
    isLoading: true,
    error: null,
    isInitialized: false,
    refreshUser: async () => null,
});

interface UserProviderProps {
    children: React.ReactNode;
    initialUser?: ClientUser | null;
}

export function UserProvider({ children, initialUser }: UserProviderProps) {
    const [user, setUser] = useState<ClientUser | null>(initialUser ?? null);
    const [isLoading, setIsLoading] = useState(!initialUser);
    const [error, setError] = useState<Error | null>(null);
    const [isInitialized, setIsInitialized] = useState(!!initialUser);
    const requestSeq = useRef(0);

    useEffect(() => {
        if (initialUser) {
            setUser(initialUser);
            setIsInitialized(true);
            setIsLoading(false);
            return;
        }

        const controller = new AbortController();
        const requestId = ++requestSeq.current;
        let timeoutId: ReturnType<typeof setTimeout> | null = setTimeout(() => {
            controller.abort();
        }, 10000);

        const loadUser = async () => {
            try {
                setIsLoading(true);
                setError(null);

                const nextUser = await fetchCurrentUser(controller.signal);

                if (controller.signal.aborted || requestSeq.current !== requestId) {
                    return;
                }

                setUser(nextUser);
                setIsInitialized(true);
            } catch (err) {
                if (controller.signal.aborted || (err instanceof DOMException && err.name === "AbortError")) {
                    return;
                }

                console.error("Failed to load current user", err);
                setError(err instanceof Error ? err : new Error("Unable to load current user"));
            } finally {
                if (timeoutId) clearTimeout(timeoutId);
                if (!controller.signal.aborted && requestSeq.current === requestId) {
                    setIsLoading(false);
                }
            }
        };

        void loadUser();

        return () => {
            if (timeoutId) clearTimeout(timeoutId);
            controller.abort();
        };
    }, [initialUser]);

    const usersById = useMemo(() => {
        if (!user) return {};
        const id =
            typeof user._id === "string" ? user._id : String(user._id);
        return {
            [id]: user,
        }
    }, [user]);

    return (
        <UserContext.Provider
            value={{
                user,
                usersById,
                isLoading,
                error,
                isInitialized,
                refreshUser: async () => {
                    const refreshed = await fetchCurrentUser();
                    setUser(refreshed);
                    setIsInitialized(true);
                    return refreshed;
                },
            }}
        >
            {children}
        </UserContext.Provider>
    );
}

export function useUser() {
    return useContext(UserContext);
}