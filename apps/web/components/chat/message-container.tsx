"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import useChatStore from "@/store/chat-store";
import { socket } from "@/lib/socket/socketClient";
import ChatBubble from "./chat-bubble";
import ChatDaySeparator from "../home/ChatDaySeparator";
import { useUser } from "@/context/UserContext";
import { deleteMessage, reactToMessage } from "@/lib/utils/api";
import { MessageEditPayload, SocketEvents } from "@chat/types";
import { UIMessage } from "@chat/types";
import { AnimatePresence, motion } from "framer-motion";
import { useConversationPresence } from "@/lib/hooks/useConversationPresence";
import { useMessageDelivery } from "@/lib/hooks/useMessageDelivery";
import { recordApiTiming } from "@/lib/utils/performance";

interface MessageContainerProps {
    conversationId: string;
}

const MessageContainer = ({ conversationId }: MessageContainerProps) => {
    const sel = useChatStore((s) => s.selectedConversationId);
    let lastDate: string | null = null;
    const messagesByConversation = useChatStore((s) => s.messagesByConversation);
    const setMessages = useChatStore((s) => s.setMessages);
    const setHasMore = useChatStore((s) => s.setHasMore);
    const updateEditedMessage = useChatStore((s) => s.updateEditedMessage);
    const setReplyTo = useChatStore((s) => s.setReplyTo);
    const topRef = useRef<HTMLDivElement>(null);
    const bottomRef = useRef<HTMLDivElement>(null);
    const { user } = useUser();
    const currentUserId = user?._id ?? null;
    const [newMessages, setNewMessages] = useState(false);
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const [loading, setLoading] = useState(false);

    useConversationPresence(conversationId);
    useMessageDelivery({ conversationId, currentUserId });

    const fetchMessages = useCallback(async (cursor?: string, signal?: AbortSignal) => {
        if (!sel) return;
        try {
            setLoading(true);
            for (let attempt = 0; attempt < 2; attempt += 1) {
                try {
                    const startedAt = performance.now();
                    const res = await fetch(
                        `/api/messages?conversationId=${sel}&cursor=${cursor || ""}`,
                        { signal, cache: "no-store", credentials: "include" }
                    );
                    const data = await res.json() as UIMessage[];
                    const redata = data.reverse();
                    if (redata.length < 20) setHasMore(String(sel), false);
                    setMessages(String(sel), redata, !!cursor);
                    recordApiTiming(`/api/messages?conversationId=${sel}`, performance.now() - startedAt);
                    return;
                } catch (error) {
                    if (signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) {
                        return;
                    }

                    if (attempt === 1) {
                        throw error;
                    }

                    await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
                }
            }
        } catch (err) {
            if (signal?.aborted || (err instanceof DOMException && err.name === "AbortError")) {
                return;
            }
            console.error("Failed to load messages", err);
        } finally {
            if (!signal?.aborted) {
                setLoading(false);
            }
        }
    }, [sel, setMessages, setHasMore]);

    useEffect(() => {
        if (messagesByConversation[conversationId]?.length > 0 && bottomRef.current) {
            bottomRef.current.scrollIntoView({ behavior: "auto" });
        }
    }, [conversationId, messagesByConversation]);

    useEffect(() => {
        if (bottomRef.current) {
            bottomRef.current.scrollIntoView({ behavior: "smooth" });
        }
    }, [conversationId, messagesByConversation]);

    useEffect(() => {
        const controller = new AbortController();
        void fetchMessages(undefined, controller.signal);

        return () => {
            controller.abort();
        };
    }, [sel, fetchMessages]);

    const handleReact = async (message: UIMessage, emoji: string) => {
        await reactToMessage(message, emoji);
    };

    useEffect(() => {
        if (!sel) return;

        // JOIN

        const handleEditMessage = (data: MessageEditPayload) => {
            updateEditedMessage(data.conversationId, data.messageId, data.text);
        };

        socket.on(SocketEvents.MESSAGE_EDITED, handleEditMessage);

        return () => {
            socket.off(SocketEvents.MESSAGE_EDITED, handleEditMessage);
        };
    }, [updateEditedMessage, sel]);

    const scrollToBottom = () => {
        bottomRef.current?.scrollIntoView({ behavior: "smooth" });
        setNewMessages(false);
    };

    // typingText is not used, so removed.

    // Group messages by sender and time
    function groupMessages(messages: UIMessage[]) {
        const groups: Array<{ messages: UIMessage[]; showAvatar: boolean; showUsername: boolean }> = [];
        let prev: UIMessage | null = null;
        // ...existing code...
        for (const msg of messages) {
            const msgDate = new Date(msg.createdAt);
            let showAvatar = true;
            let showUsername = true;
            if (
                prev &&
                prev.sender && msg.sender &&
                String(prev.sender._id || prev.sender) === String(msg.sender._id || msg.sender) &&
                Math.abs(new Date(prev.createdAt).getTime() - msgDate.getTime()) < 2 * 60 * 1000
            ) {
                showAvatar = false;
                showUsername = false;
                groups[groups.length - 1].messages.push(msg);
            } else {
                groups.push({ messages: [msg], showAvatar, showUsername });
            }
            prev = msg;
        }
        return groups;
    }

    const grouped = groupMessages(messagesByConversation[conversationId] ?? []);

    return (
        <div className="relative h-full min-h-0 flex-1 overflow-y-auto bg-[hsl(var(--container))] bg-chat-tile-light bg-repeat pb-24 text-[hsl(var(--foreground))] dark:bg-chat-tile-dark sm:pb-28 lg:pb-0">
            {/* Floating New Messages button */}
            {newMessages && (
                <button
                    className="fixed bottom-28 left-1/2 z-50 -translate-x-1/2 animate-fade-in rounded-full bg-green-primary px-4 py-2 text-sm text-white shadow-lg sm:bottom-32 lg:bottom-24"
                    onClick={scrollToBottom}
                >
                    New Messages
                </button>
            )}
            <div className="mx-auto flex h-full w-full max-w-4xl flex-col gap-3 px-2 py-3 sm:px-4 sm:py-4 md:px-6">
                <div ref={topRef} />
                <AnimatePresence initial={false}>
                    {user && grouped.map((group) => (
                        <motion.div
                            key={String(group.messages[0]._id)}
                            initial={{ opacity: 0, y: 16 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: 16 }}
                            transition={{ duration: 0.22, ease: "easeOut" }}
                        >
                            {/* Day separator for first message in group */}
                            {(() => {
                                const msgDate = new Date(group.messages[0].createdAt);
                                const dayKey = msgDate.toDateString();
                                const showSeparator = lastDate !== dayKey;
                                lastDate = dayKey;
                                return showSeparator ? <ChatDaySeparator date={msgDate} /> : null;
                            })()}
                            {group.messages.map((msg, i) => (
                                <ChatBubble
                                    key={String(msg._id)}
                                    message={msg}
                                    currentUserId={user?._id}
                                    onDelete={deleteMessage}
                                    onReply={(msg) => setReplyTo(conversationId, msg)}
                                    onReact={handleReact}
                                    showAvatar={group.showAvatar && i === 0}
                                    showUsername={group.showUsername && i === 0}
                                />
                            ))}
                        </motion.div>
                    ))}
                </AnimatePresence>
                <div ref={bottomRef} />
            </div>
        </div>
    );
};

export default MessageContainer;
