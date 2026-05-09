/**
 * Optimized hook for message input user fetching
 * Removes duplicate fetch by using useUser context instead
 */

import { useUser } from "@/context/UserContext";
import { useMemo } from "react";

/**
 * Get current user data from context (already cached)
 * Never fetches again - uses UserProvider's cached data
 */
export function useMessageInputUser() {
    const { user, isLoading } = useUser();

    // Memoize to prevent unnecessary re-renders
    const userInfo = useMemo(() => ({
        id: user?._id,
        username: user?.username,
        email: user?.email,
        avatar: user?.profilePicture,
        isReady: !!user && !isLoading,
    }), [user, isLoading]);

    return userInfo;
}
