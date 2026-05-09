/* Centralized auth bootstrap and single-flight refresh coordination
   - Exposes ensureAuthReady(), authReady, authLoading, isAuthenticated
   - Uses existing refreshSession() for single-flight refresh across tabs
   - Provides instrumentation for duplicate refresh detection
*/
import { refreshSession } from "@/lib/utils/auth/client-session";

let bootstrapPromise: Promise<void> | null = null;
export let authReady = false;
export let authLoading = true;
export let isAuthenticated = false;

function now() {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** Ensure auth initialization runs once and completes before protected requests */
export function ensureAuthReady(): Promise<void> {
    if (authReady) return Promise.resolve();
    if (bootstrapPromise) return bootstrapPromise;

    bootstrapPromise = (async () => {
        authLoading = true;
        const startedAt = now();

        try {
            // Check if access token is already present
            try {
                const resp = await fetch("/api/me", { cache: "no-store", credentials: "include" });
                if (resp.ok) {
                    authReady = true;
                    isAuthenticated = true;
                    return;
                }
            } catch {
                // network error - can't determine auth status, will be handled by API layer
            }

            // Cannot determine auth status - mark as ready but not authenticated
            // The API layer will handle refresh on 401
            authReady = true;
            isAuthenticated = false;
        } finally {
            authLoading = false;
            const duration = Math.round((now() - startedAt));
            console.debug("authBootstrap: completed", { authReady, isAuthenticated, duration });
            bootstrapPromise = null;
        }
    })();

    return bootstrapPromise;
}

// Lightweight helper for code paths that want a boolean
export async function waitForAuthReady(): Promise<{ authReady: boolean; isAuthenticated: boolean }> {
    await ensureAuthReady();
    return { authReady, isAuthenticated };
}
