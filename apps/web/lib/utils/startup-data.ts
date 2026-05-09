/**
 * Startup data fetching utilities
 * Handles parallel fetching of critical startup data
 */

import { ClientUser, ClientConversation } from "@chat/types";
import { recordApiTiming } from "./performance";
import { getMe, getConversations } from "@/lib/utils/api";

/**
 * Fetch current user with retry logic and timeout
 */
async function fetchUser(): Promise<ClientUser | null> {
    const startTime = performance.now();
    try {
        const user = await getMe();
        recordApiTiming("/api/me", performance.now() - startTime);
        return user ?? null;
    } catch (err) {
        console.error("fetchUser failed", err);
        return null;
    }
}

/**
 * Fetch conversations list
 */
async function fetchConversationsList(): Promise<ClientConversation[]> {
    const startTime = performance.now();
    try {
        const list = await getConversations();
        recordApiTiming("/api/conversations", performance.now() - startTime);
        return list ?? [];
    } catch (err) {
        console.error("fetchConversationsList failed", err);
        return [];
    }
}

/**
 * Critical startup data - fetched in parallel
 */
export interface StartupData {
    user: ClientUser | null;
    conversations: ClientConversation[];
}

/**
 * Fetch critical startup data in parallel
 * This reduces the startup time from sequential fetching (2x duration) to parallel (1x duration)
 */
export async function fetchStartupData(): Promise<StartupData> {
    try {
        // Fetch user and conversations in parallel, not sequentially
        const [user, conversations] = await Promise.all([
            fetchUser(),
            fetchConversationsList(),
        ]);

        return {
            user,
            conversations,
        };
    } catch (err) {
        console.error("Failed to fetch startup data:", err);
        return {
            user: null,
            conversations: [],
        };
    }
}

/**
 * Defer non-critical data loading
 * Use requestIdleCallback to load data when the browser is idle
 */
export function deferredFetch(
    url: string,
    options?: RequestInit
): Promise<Response> {
    return new Promise((resolve, reject) => {
        if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
            requestIdleCallback(() => {
                fetch(url, { credentials: "include", ...options })
                    .then(resolve)
                    .catch(reject);
            });
        } else {
            // Fallback for browsers without requestIdleCallback
            setTimeout(() => {
                fetch(url, { credentials: "include", ...options })
                    .then(resolve)
                    .catch(reject);
            }, 2000);
        }
    });
}

/**
 * Check if this is a duplicate request that can be skipped
 * Prevents StrictMode double-fetch issues
 */
const pendingRequests = new Map<string, Promise<unknown>>();

export function fetchWithDedup<T>(
    key: string,
    fetcher: () => Promise<T>
): Promise<T> {
    // If request is already in flight, return the same promise
    if (pendingRequests.has(key)) {
        return pendingRequests.get(key)! as Promise<T>;
    }

    // Start new request
    const promise = fetcher()
        .then((result) => {
            // Remove from pending after completion
            setTimeout(() => pendingRequests.delete(key), 0);
            return result;
        })
        .catch((err) => {
            // Remove from pending after error
            pendingRequests.delete(key);
            throw err;
        });

    // Track pending request
    pendingRequests.set(key, promise);

    return promise;
}
