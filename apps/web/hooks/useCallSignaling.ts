"use client";

import { useCallback, useEffect } from "react";
import {
    type CallAcceptPayload,
    type CallAnswerPayload,
    type CallEndPayload,
    type CallIceCandidatePayload,
    type CallOfferInitPayload,
    type CallOfferPayload,
    type CallRejectPayload,
    type CallReconnectPayload,
    type CallStatePayload,
    SocketEvents,
} from "@chat/types";
import { useSocket } from "@/hooks/useSocket";
import useCallStore from "@/store/call-store";

export function useCallSignaling() {
    const socket = useSocket();

    const setIncomingCall = useCallStore((state) => state.setIncomingCall);
    const setStatus = useCallStore((state) => state.setStatus);
    const setParticipants = useCallStore((state) => state.setParticipants);
    const endCall = useCallStore((state) => state.endCall);
    const stopRingtone = useCallStore((state) => state.stopRingtone);
    const setError = useCallStore((state) => state.setError);

    useEffect(() => {
        const onRinging = (payload: CallOfferInitPayload) => {
            setIncomingCall({
                callId: payload.callId,
                conversationId: payload.conversationId,
                callType: payload.callType,
                participants: [{ userId: payload.from }, { userId: payload.to }],
            });
        };

        const onCallState = (payload: CallStatePayload) => {
            setStatus(payload.status);
            setParticipants(payload.participants);
        };

        const onCallAccepted = () => {
            stopRingtone();
            setStatus("accepted");
        };

        const onCallRejected = () => {
            stopRingtone();
            setStatus("rejected");
        };

        const onCallEnded = () => {
            endCall();
        };

        const onError = (error: unknown) => {
            setError(error instanceof Error ? error.message : "Call signaling failed");
        };

        socket.on(SocketEvents.CALL_OFFER_INIT, onRinging);
        socket.on(SocketEvents.CALL_STATE, onCallState);
        socket.on(SocketEvents.CALL_ACCEPT, onCallAccepted);
        socket.on(SocketEvents.CALL_REJECT, onCallRejected);
        socket.on(SocketEvents.CALL_END, onCallEnded);
        socket.on("connect_error", onError);

        return () => {
            socket.off(SocketEvents.CALL_OFFER_INIT, onRinging);
            socket.off(SocketEvents.CALL_STATE, onCallState);
            socket.off(SocketEvents.CALL_ACCEPT, onCallAccepted);
            socket.off(SocketEvents.CALL_REJECT, onCallRejected);
            socket.off(SocketEvents.CALL_END, onCallEnded);
            socket.off("connect_error", onError);
        };
    }, [socket, setIncomingCall, setStatus, setParticipants, endCall, stopRingtone, setError]);

    const emitOfferInit = useCallback(
        (payload: CallOfferInitPayload) => {
            socket.emit(SocketEvents.CALL_OFFER_INIT, payload);
        },
        [socket]
    );

    const emitOffer = useCallback(
        (payload: CallOfferPayload) => {
            socket.emit(SocketEvents.CALL_OFFER, payload);
        },
        [socket]
    );

    const emitAnswer = useCallback(
        (payload: CallAnswerPayload) => {
            socket.emit(SocketEvents.CALL_ANSWER, payload);
        },
        [socket]
    );

    const emitIceCandidate = useCallback(
        (payload: CallIceCandidatePayload) => {
            socket.emit(SocketEvents.CALL_ICE_CANDIDATE, payload);
        },
        [socket]
    );

    const emitAccept = useCallback(
        (payload: CallAcceptPayload) => {
            socket.emit(SocketEvents.CALL_ACCEPT, payload);
        },
        [socket]
    );

    const emitReject = useCallback(
        (payload: CallRejectPayload) => {
            socket.emit(SocketEvents.CALL_REJECT, payload);
        },
        [socket]
    );

    const emitEnd = useCallback(
        (payload: CallEndPayload) => {
            socket.emit(SocketEvents.CALL_END, payload);
        },
        [socket]
    );

    const emitReconnect = useCallback(
        (payload: CallReconnectPayload) => {
            socket.emit(SocketEvents.CALL_RECONNECT, payload);
        },
        [socket]
    );

    return {
        emitOfferInit,
        emitOffer,
        emitAnswer,
        emitIceCandidate,
        emitAccept,
        emitReject,
        emitEnd,
        emitReconnect,
    };
}
