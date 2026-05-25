'use client';

import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { Laugh, Mic, Plus, Send, Image as ImageIcon } from "lucide-react";
import { Input } from "../ui/input";
import { Button } from "../ui/button";
import { authenticatedFetch } from "@/lib/utils/api";
import useChatStore from "@/store/chat-store";
import { getSocket } from "@/lib/socket/socketClient";
import { ImageUpload } from "../home/ImageUpload";
import { toast } from "sonner"
import { v4 as uuidv4 } from 'uuid';
import { useOfflineStore } from '@/store/offline-store';
import { useNetworkStatus } from '@/lib/hooks/useNetworkStatus';
import { useRateLimitHandler } from "@/lib/hooks/useRateLimitHandler";
import useSocketStore from "@/store/useSocketStore";
import { UIMessage } from "@chat/types";
import { SocketEvents } from "@chat/types";
import { useUser } from "@/context/UserContext";

// 🧠 Small debounce util
function debounce<T extends unknown[]>(fn: (...args: T) => void, delay: number) {
    let timeout: NodeJS.Timeout;
    return (...args: T) => {
        clearTimeout(timeout);
        timeout = setTimeout(() => fn(...args), delay);
    };
}

const MessageInput = () => {
    const [msgText, setMsgText] = useState("");
    const [showImageUpload, setShowImageUpload] = useState(false);
    const typingTimeoutRef = useRef<NodeJS.Timeout | null>(null);

    const { user: me } = useUser();
    const selectedConversation = useChatStore((s) => s.selectedConversation);
    const addMessage = useChatStore((s) => s.addMessage);
    const updateLastMessage = useChatStore((s) => s.updateLastMessage);
    const replaceTempMessage = useChatStore((s) => s.replaceTempMessage);
    const editingMessage = useChatStore((s) => s.editingMessage);
    const clearEditingMessage = useChatStore((s) => s.clearEditingMessage);
    const updateEditedMessage = useChatStore((s) => s.updateEditedMessage);
    const repliedTo = useChatStore((s) => s.repliedTo);
    const clearReplyTo = useChatStore((s) => s.clearReplyTo);
    const sel = useChatStore((s) => s.selectedConversationId);
    const isOnline = useNetworkStatus();
    const { addToQueue } = useOfflineStore();
    const { sendMessage } = useSocketStore();
    const socket = getSocket();
    //  Rate limit handler
    const { isRateLimited, timeLeft, triggerRateLimit } = useRateLimitHandler(5000);
    const conversationMembers = useMemo(
        () =>
            selectedConversation?.participants.map((member) => String(member._id)) ?? [],
        [selectedConversation]
    );
    const activeReply = sel ? repliedTo[sel] : undefined;

    useEffect(() => {
        if (editingMessage) {
            setMsgText(editingMessage.content);
        }
    }, [editingMessage]);

    // 📝 Handle typing indicators with debounce
    const handleTyping = useCallback(
        (conversationId: string) => {
            if (!me) return;
            socket.emit(SocketEvents.TYPING_START, {
                conversationId,
                userId: String(me._id),
                conversationMembers,
            });
            if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);

            typingTimeoutRef.current = setTimeout(() => {
                socket.emit(SocketEvents.TYPING_STOP, {
                    conversationId,
                    userId: String(me._id),
                    conversationMembers,
                });
            }, 2000);
        },
        [me, socket, conversationMembers]
    );

    const debouncedTyping = useMemo(() => debounce(handleTyping, 300), [handleTyping]);

    // 📤 Send text message
    const handleSendMessage = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!msgText.trim() || !me || !sel || isRateLimited) return;

        if (editingMessage) {
            try {
                const res = await authenticatedFetch(`/api/messages/${editingMessage._id}/edit`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        newText: msgText.trim(),
                        messageId: editingMessage._id,
                    }),
                });
                if (!res.ok) {
                    toast.error("failed to edit message")
                    return;
                }
                socket.emit("message:edit", {
                    conversationId: String(sel),
                    messageId: String(editingMessage._id),
                    text: msgText.trim(),
                });
                updateEditedMessage(String(sel), String(editingMessage._id), msgText.trim());
                clearEditingMessage();
                setMsgText("");
            } catch (error) {
                console.error("Failed to edit message", error);
                toast.error("Failed to edit message");
            }
            return;
        }


        const replyToId = activeReply?._id;
        const tempId = uuidv4();
        const tempMessage: UIMessage = {
            _id: tempId,
            conversationId: String(sel),
            sender: {
                _id: String(me._id),
                username: me.username,
                profilePicture: me.profilePicture
            },
            content: msgText.trim(),
            messageType: "text",
            status: isOnline ? "pending" : "queued",
            isDeleted: false,
            createdAt: new Date(),
            isTemp: true,
            ...(activeReply ? {
                repliedTo: {
                    _id: String(activeReply._id),
                    content: activeReply.content,
                    sender: activeReply.sender,
                },
            } : {}),
        };

        addMessage(sel, tempMessage);
        setMsgText("");
        if (activeReply && sel) clearReplyTo(String(sel));

        if (!isOnline || socket.disconnected) {
            await addToQueue({
                tempId,
                conversationId: String(sel),
                conversationMembers,
                senderId: String(me._id), // ✅ required
                content: tempMessage.content,
                messageType: tempMessage.messageType,
                createdAt: tempMessage.createdAt,
                status: "queued",
            });
            toast("Message queued. Will send when online.");
            return;
        }

        try {
            const res = await authenticatedFetch("/api/messages", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    content: tempMessage.content,
                    conversationId: sel,
                    ...(replyToId ? { replyTo: replyToId } : {}),
                }),
            });

            if (res.status === 429) {
                triggerRateLimit(); // ✅ centralized
                return;
            }

            if (!res.ok) throw new Error("Failed to send message");
            const message = await res.json();

            sendMessage(message, conversationMembers);
            updateLastMessage(String(sel), message);
            replaceTempMessage(String(sel), tempId, message);
        } catch (err) {
            console.error("Send message failed:", err);
            toast.error("Message failed to send");
        }
    };

    // 🖼️ Handle image upload (same as before)
    const handleImageUpload = async (result: { url?: string; fileId?: string }) => {
        if (!result.url || !me || !sel) return;

        try {
            const res = await authenticatedFetch("/api/messages", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    content: result.url,
                    conversationId: sel,
                    senderId: me._id,
                    messageType: "image",
                }),
            });

            if (!res.ok) throw new Error("Failed to send image message");

            const message = await res.json();
            addMessage(String(sel), message);
            sendMessage(message, conversationMembers);
            toast.success("Image sent successfully!");
            setShowImageUpload(false);
        } catch (err) {
            console.error("Send image message failed:", err);
            toast.error("Failed to send image");
        }
    };

    return (<>
        {false && (
            <div className="bg-amber-600 flex items-center gap-2 ml-4 mt-2 text-sm text-gray-500 dark:text-gray-400">
                <span>typingText</span>
                <div className="flex space-x-1 animate-bounce">
                    <span className="dot"></span>
                    <span className="dot"></span>
                    <span className="dot"></span>
                </div>
            </div>
        )}
        <div className="relative mx-auto flex w-full max-w-4xl flex-col gap-2 bg-[hsl(var(--card))] px-2 py-2 text-[hsl(var(--foreground))] lg:rounded-b-2xl sm:px-4 md:px-6">
            <form className="flex w-full items-center gap-1.5 sm:gap-2" onSubmit={handleSendMessage}>
                {/* Emoji, Attach, Image */}
                <div className="flex shrink-0 items-center gap-1 sm:gap-2">
                    <button type="button" className="inline-flex h-9 w-9 items-center justify-center rounded-full transition hover:bg-[hsl(var(--chat-hover))] sm:h-10 sm:w-10" aria-label="Add emoji">
                        <Laugh className="text-[hsl(var(--muted-foreground))]" size={20} />
                    </button>
                    <button type="button" className="inline-flex h-9 w-9 items-center justify-center rounded-full transition hover:bg-[hsl(var(--chat-hover))] sm:h-10 sm:w-10" aria-label="Attach file">
                        <Plus className="text-[hsl(var(--muted-foreground))]" size={20} />
                    </button>
                    <button type="button" className="inline-flex h-9 w-9 items-center justify-center rounded-full transition hover:bg-[hsl(var(--chat-hover))] sm:h-10 sm:w-10" aria-label="Upload image" onClick={() => setShowImageUpload(!showImageUpload)}>
                        <ImageIcon className="text-[hsl(var(--muted-foreground))]" size={20} />
                    </button>
                </div>
                {/* Input */}
                <div className="flex-1 relative">
                    {(activeReply || editingMessage) && (
                        <div className="absolute -top-12 left-0 z-10 flex w-full items-center justify-between rounded-t-md border border-[hsl(var(--border))] bg-[hsl(var(--gray-primary))] p-2 text-[11px] text-[hsl(var(--foreground))] sm:-top-10 sm:text-xs">
                            {activeReply && (
                                <span>
                                    Replying to{" "}
                                    <span className="font-semibold">
                                        {typeof activeReply.sender !== "string"
                                            ? activeReply.sender.username
                                            : "someone"}
                                    </span>
                                    {activeReply.content.length > 0 && (
                                        <>: <span className="opacity-75">{activeReply.content.length > 48 ? activeReply.content.slice(0, 48) + "…" : activeReply.content}</span></>
                                    )}
                                </span>
                            )}
                            {editingMessage && <span>Editing: <span className="font-semibold">{editingMessage.content}</span></span>}
                            <button
                                type="button"
                                className="ml-2 text-xs text-[hsl(var(--primary))] hover:underline"
                                onClick={() => {
                                    if (activeReply && sel) {
                                        clearReplyTo(String(sel));
                                    } else {
                                        clearEditingMessage();
                                        setMsgText("");
                                    }
                                }}
                            >
                                Cancel
                            </button>
                        </div>
                    )}
                    <Input
                        type="text"
                        placeholder={isRateLimited ? `Please wait ${timeLeft}s...` : "Type a message"}
                        className="h-10 w-full rounded-full border border-[hsl(var(--border))] bg-[hsl(var(--input))] px-4 py-2 text-sm text-[hsl(var(--foreground))] shadow-none transition focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))] sm:h-11"
                        value={msgText}
                        onChange={(e) => {
                            setMsgText(e.target.value);
                            if (sel && !isRateLimited) debouncedTyping(String(sel));
                        }}
                        disabled={isRateLimited}
                        onKeyDown={(e) => {
                            if (e.key === "Enter" && !e.shiftKey) {
                                e.preventDefault();
                                handleSendMessage(e);
                            }
                            if (e.key === "Escape") {
                                clearEditingMessage();
                            }
                        }}
                    />
                </div>
                {/* Send / Mic */}
                <div className="flex items-center gap-1">
                    {msgText.trim().length > 0 ? (
                        <Button
                            type="submit"
                            size="icon"
                            className="h-9 w-9 rounded-full bg-green-primary p-2 text-white shadow-none transition-opacity hover:opacity-90 sm:h-10 sm:w-10"
                            disabled={isRateLimited}
                            aria-label="Send message"
                        >
                            <Send size={20} />
                        </Button>
                    ) : (
                        <Button
                            type="button"
                            size="icon"
                            className="h-9 w-9 rounded-full bg-green-primary p-2 text-white transition-opacity hover:opacity-90 sm:h-10 sm:w-10"
                            disabled={isRateLimited}
                            aria-label="Record voice"
                        >
                            <Mic size={20} />
                        </Button>
                    )}
                </div>
            </form>
            {/* Image upload popover */}
            {showImageUpload && (
                <div className="absolute bottom-full left-1/2 z-20 mb-2 w-[min(16rem,calc(100vw-1rem))] -translate-x-1/2 rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-4 shadow-xl sm:left-0 sm:w-64 sm:translate-x-0">
                    <div className="flex justify-between items-center mb-2">
                        <h3 className="text-sm font-medium text-[hsl(var(--foreground))]">Send Image</h3>
                        <button
                            onClick={() => setShowImageUpload(false)}
                            className="text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]"
                            aria-label="Close upload panel"
                        >
                            ✕
                        </button>
                    </div>
                    <ImageUpload
                        onSuccess={handleImageUpload}
                        onProgress={(progress) => {
                            if (progress === 100) toast.success("Image uploaded successfully!");
                        }}
                    />
                </div>
            )}
        </div>
    </>
    );
};

export default MessageInput;