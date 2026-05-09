"use client";

import { useMemo } from "react";
import useChatStore from "@/store/chat-store";

interface TypingIndicatorProps {
    conversationId: string;
}

export default function TypingIndicator({ conversationId }: TypingIndicatorProps) {
    const typingByConversation = useChatStore((s) => s.typingByConversation);
    const conversations = useChatStore((s) => s.conversations);
    const currentUserId = useChatStore((s) => s.currentUserId);

    const typingText = useMemo(() => {
        const typingUserIds = typingByConversation[conversationId] || [];
        if (typingUserIds.length === 0) return null;

        const conversation = conversations.find(
            (item) => String(item._id) === conversationId
        );
        if (!conversation) return null;

        const names = typingUserIds
            .filter((userId) => userId && userId !== currentUserId)
            .map((userId) => {
                const participant = conversation.participants.find(
                    (user) => String(user._id) === userId
                );
                return participant?.username || "Someone";
            });

        const uniqueNames = Array.from(new Set(names));
        if (uniqueNames.length === 0) return null;

        if (uniqueNames.length === 1) {
            return `${uniqueNames[0]} is typing`;
        }

        return `${uniqueNames.join(", ")} are typing`;
    }, [typingByConversation, conversationId, conversations, currentUserId]);

    if (!typingText) return null;

    return (
        <div className="border-t border-[hsl(var(--border))] bg-[hsl(var(--card))] px-3 py-1.5 sm:px-4 sm:py-2">
            <div className="flex items-center gap-2 text-sm text-green-primary">
                <span>{typingText}</span>
                <div className="flex items-center gap-1">
                    <span className="h-2 w-2 animate-typing-dot rounded-full bg-green-primary" />
                    <span className="h-2 w-2 animate-typing-dot rounded-full bg-green-primary animation-delay-150" />
                    <span className="h-2 w-2 animate-typing-dot rounded-full bg-green-primary animation-delay-300" />
                </div>
            </div>
        </div>
    );
}
