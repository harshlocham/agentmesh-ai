"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PeerManager } from "@/lib/webrtc/peer-manager";

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
    { urls: ["stun:stun.l.google.com:19302"] },
];

type UseWebRTCOptions = {
    onIceCandidate?: (candidate: RTCIceCandidate) => void;
};

export function useWebRTC(options: UseWebRTCOptions = {}) {
    const [localStream, setLocalStream] = useState<MediaStream | null>(null);
    const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
    const [connectionState, setConnectionState] =
        useState<RTCPeerConnectionState>("new");

    const remoteStreamRef = useRef<MediaStream>(new MediaStream());

    const manager = useMemo(
        () =>
            new PeerManager(
                {
                    iceServers: DEFAULT_ICE_SERVERS,
                },
                {
                    onIceCandidate: options.onIceCandidate,
                    onTrack: (event) => {
                        event.streams[0]?.getTracks().forEach((track) => {
                            remoteStreamRef.current.addTrack(track);
                        });
                        setRemoteStream(new MediaStream(remoteStreamRef.current.getTracks()));
                    },
                    onConnectionStateChange: (state) => {
                        setConnectionState(state);
                    },
                }
            ),
        [options.onIceCandidate]
    );

    const startLocalMedia = useCallback(async () => {
        const stream = await navigator.mediaDevices.getUserMedia({
            audio: true,
            video: true,
        });
        setLocalStream(stream);
        await manager.addLocalStream(stream);
        return stream;
    }, [manager]);

    const stopLocalMedia = useCallback(() => {
        localStream?.getTracks().forEach((track) => track.stop());
        setLocalStream(null);
    }, [localStream]);

    const createOffer = useCallback(async () => manager.createOffer(), [manager]);

    const handleOffer = useCallback(
        async (offer: RTCSessionDescriptionInit) => manager.handleOffer(offer),
        [manager]
    );

    const handleAnswer = useCallback(
        async (answer: RTCSessionDescriptionInit) => manager.handleAnswer(answer),
        [manager]
    );

    const handleICE = useCallback(
        async (candidate: RTCIceCandidateInit) => manager.handleICE(candidate),
        [manager]
    );

    const reconnect = useCallback(async () => manager.restartIce(), [manager]);

    const close = useCallback(() => {
        stopLocalMedia();
        remoteStreamRef.current.getTracks().forEach((track) => track.stop());
        remoteStreamRef.current = new MediaStream();
        setRemoteStream(null);
        manager.close();
    }, [manager, stopLocalMedia]);

    useEffect(() => {
        return () => {
            close();
        };
    }, [close]);

    return {
        localStream,
        remoteStream,
        connectionState,
        startLocalMedia,
        stopLocalMedia,
        createOffer,
        handleOffer,
        handleAnswer,
        handleICE,
        reconnect,
        close,
    };
}
