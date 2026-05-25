"use client";

import { useEffect, useRef, useState } from "react";
import { useOfflineStore } from "@/store/offline-store";
import { useNetworkStatus } from "./useNetworkStatus";
import { socket } from "@/lib/socket/socketClient";
import useChatStore from "@/store/chat-store"; // adjust import path
import toast from "react-hot-toast";
import { authenticatedFetch } from "@/lib/utils/api";

export function useOfflineMessageSync() {
    const isOnline = useNetworkStatus();
    const offlineQueue = useOfflineStore((s) => s.offlineQueue);
    const loadQueue = useOfflineStore((s) => s.loadQueue);
    const removeFromQueue = useOfflineStore((s) => s.removeFromQueue);
    const isResending = useRef(false);
    const [socketConnected, setSocketConnected] = useState(socket.connected);
    const replaceTempMessage = useChatStore((s) => s.replaceTempMessage);
    const conversations = useChatStore((s) => s.conversations);

    // Load messages from IndexedDB once
    useEffect(() => {
        loadQueue();
    }, [loadQueue]);

    useEffect(() => {
        const handleConnect = () => setSocketConnected(true);
        const handleDisconnect = () => setSocketConnected(false);

        socket.on("connect", handleConnect);
        socket.on("disconnect", handleDisconnect);

        return () => {
            socket.off("connect", handleConnect);
            socket.off("disconnect", handleDisconnect);
        };
    }, []);

    useEffect(() => {
        if (!isOnline || !socketConnected || isResending.current) return;
        if (offlineQueue.length === 0) return;

        const resendQueuedMessages = async () => {
            isResending.current = true;
            console.log("[OfflineSync] Starting queued message resend...");

            let sentCount = 0;
            let failedCount = 0;

            try {
                for (const msg of offlineQueue) {
                    let success = false;
                    let delay = 1000; // start at 1 second
                    const maxRetries = 5;

                    for (let attempt = 1; attempt <= maxRetries; attempt++) {
                        try {
                            const res = await authenticatedFetch("/api/messages", {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({
                                    content: msg.content,
                                    conversationId: msg.conversationId,
                                    senderId: msg.senderId,
                                }),
                            });

                            if (!res.ok) {
                                throw new Error("Failed to send message");
                            }

                            const savedMsg = await res.json();

                            const fallbackMembers =
                                conversations
                                    .find((conv) => String(conv._id) === msg.conversationId)
                                    ?.participants.map((participant) => String(participant._id)) ?? [];

                            const conversationMembers =
                                Array.isArray(msg.conversationMembers) && msg.conversationMembers.length > 0
                                    ? msg.conversationMembers
                                    : fallbackMembers;

                            socket.emit("message:send", {
                                data: savedMsg,
                                conversationMembers,
                            });
                            replaceTempMessage(msg.conversationId, msg.tempId, savedMsg);
                            await removeFromQueue(msg.tempId);

                            console.log(`[OfflineSync] Sent message ${msg.tempId}`);
                            success = true;
                            sentCount += 1;
                            break;
                        } catch (err) {
                            console.warn(
                                `[OfflineSync] Attempt ${attempt} failed for ${msg.tempId}`,
                                err
                            );
                            if (attempt < maxRetries) {
                                await new Promise((res) => setTimeout(res, delay));
                                delay *= 2; // exponential backoff
                            }
                        }
                    }

                    if (!success) {
                        console.error(
                            `[OfflineSync] Giving up after ${maxRetries} attempts for ${msg.tempId}`
                        );
                        failedCount += 1;
                    }
                }

                if (sentCount > 0 && failedCount === 0) {
                    toast.success("Offline messages sent successfully");
                }
                if (failedCount > 0) {
                    toast.error("Some offline messages could not be sent. Retrying automatically.");
                }
            } finally {
                isResending.current = false;
            }
        };

        resendQueuedMessages();
    }, [isOnline, socketConnected, offlineQueue, removeFromQueue, replaceTempMessage, conversations]);
}