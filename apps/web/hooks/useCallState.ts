"use client";

import useCallStore, { callSelectors } from "@/store/call-store";

export function useCallState() {
    const callId = useCallStore((state) => state.callId);
    const conversationId = useCallStore((state) => state.conversationId);
    const status = useCallStore((state) => state.status);
    const direction = useCallStore((state) => state.direction);
    const participants = useCallStore((state) => state.participants);
    const isIncomingModalOpen = useCallStore((state) => state.isIncomingModalOpen);
    const isRingtonePlaying = useCallStore((state) => state.isRingtonePlaying);
    const isMuted = useCallStore((state) => state.isMuted);
    const isCameraOn = useCallStore((state) => state.isCameraOn);
    const isScreenSharing = useCallStore((state) => state.isScreenSharing);
    const error = useCallStore((state) => state.error);

    const hasActiveCall = useCallStore(callSelectors.hasActiveCall);
    const isIncoming = useCallStore(callSelectors.isIncoming);
    const canAccept = useCallStore(callSelectors.canAccept);
    const canToggleMedia = useCallStore(callSelectors.canToggleMedia);

    return {
        callId,
        conversationId,
        status,
        direction,
        participants,
        isIncomingModalOpen,
        isRingtonePlaying,
        isMuted,
        isCameraOn,
        isScreenSharing,
        error,
        hasActiveCall,
        isIncoming,
        canAccept,
        canToggleMedia,
    };
}
