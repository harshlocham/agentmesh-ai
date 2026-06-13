import { create } from "zustand";
import type { CallState, CallType } from "@chat/types";

type CallDirection = "incoming" | "outgoing";

export interface CallParticipantState {
    userId: string;
    deviceId?: string;
    acceptedAt?: Date | string;
}

export interface CallStoreState {
    callId: string | null;
    conversationId: string | null;
    callType: CallType | null;
    direction: CallDirection | null;
    status: CallState | null;
    participants: CallParticipantState[];
    isIncomingModalOpen: boolean;
    isRingtonePlaying: boolean;
    isMuted: boolean;
    isCameraOn: boolean;
    isScreenSharing: boolean;
    error: string | null;
    startedAt: Date | null;
    connectedAt: Date | null;
    endedAt: Date | null;

    startOutgoingCall: (payload: {
        callId: string;
        conversationId: string;
        callType: CallType;
        participants: CallParticipantState[];
    }) => void;
    setIncomingCall: (payload: {
        callId: string;
        conversationId: string;
        callType: CallType;
        participants: CallParticipantState[];
    }) => void;
    setStatus: (status: CallState) => void;
    setParticipants: (participants: CallParticipantState[]) => void;
    setMuted: (value: boolean) => void;
    setCameraOn: (value: boolean) => void;
    setScreenSharing: (value: boolean) => void;
    setError: (message: string | null) => void;
    stopRingtone: () => void;
    endCall: () => void;
    reset: () => void;
}

const initialState = {
    callId: null,
    conversationId: null,
    callType: null,
    direction: null,
    status: null,
    participants: [],
    isIncomingModalOpen: false,
    isRingtonePlaying: false,
    isMuted: false,
    isCameraOn: true,
    isScreenSharing: false,
    error: null,
    startedAt: null,
    connectedAt: null,
    endedAt: null,
};

const useCallStore = create<CallStoreState>((set) => ({
    ...initialState,

    startOutgoingCall: ({ callId, conversationId, callType, participants }) =>
        set({
            callId,
            conversationId,
            callType,
            direction: "outgoing",
            status: "initiated",
            participants,
            startedAt: new Date(),
            endedAt: null,
            error: null,
            isIncomingModalOpen: false,
            isRingtonePlaying: false,
        }),

    setIncomingCall: ({ callId, conversationId, callType, participants }) =>
        set({
            callId,
            conversationId,
            callType,
            direction: "incoming",
            status: "ringing",
            participants,
            startedAt: new Date(),
            endedAt: null,
            error: null,
            isIncomingModalOpen: true,
            isRingtonePlaying: true,
        }),

    setStatus: (status) =>
        set((state) => ({
            status,
            connectedAt:
                status === "active" && !state.connectedAt
                    ? new Date()
                    : state.connectedAt,
        })),

    setParticipants: (participants) => set({ participants }),
    setMuted: (value) => set({ isMuted: value }),
    setCameraOn: (value) => set({ isCameraOn: value }),
    setScreenSharing: (value) => set({ isScreenSharing: value }),
    setError: (message) => set({ error: message }),

    stopRingtone: () => set({ isRingtonePlaying: false }),

    endCall: () =>
        set({
            status: "ended",
            endedAt: new Date(),
            isIncomingModalOpen: false,
            isRingtonePlaying: false,
        }),

    reset: () => set({ ...initialState }),
}));

export const callSelectors = {
    hasActiveCall: (state: CallStoreState) =>
        state.status === "active" || state.status === "reconnecting",
    isIncoming: (state: CallStoreState) => state.direction === "incoming",
    canAccept: (state: CallStoreState) =>
        state.direction === "incoming" && state.status === "ringing",
    canToggleMedia: (state: CallStoreState) =>
        state.status === "active" || state.status === "reconnecting",
};

export default useCallStore;
