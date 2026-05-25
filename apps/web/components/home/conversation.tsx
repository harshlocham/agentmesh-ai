'use client';

import { formatDate } from "@/lib/utils/utils";
import { Avatar, AvatarFallback, AvatarImage } from "../ui/avatar";
import { MessageSeenSvg } from "@/lib/utils/svgs";
import { ImageIcon, Users, VideoIcon } from "lucide-react";
import { getAvatarUrl } from "@/lib/utils/imagekit";
import { useUser } from "@/context/UserContext";
import useChatStore from "@/store/chat-store";
import { ClientConversation } from "@chat/types";
import { ClientUser } from "@chat/types";


type ConversationProps = {
    conversation: ClientConversation & { unreadCount?: number };
};

// type guard
function isUser(p: unknown): p is ClientUser {
    return typeof p === "object" && p !== null && "username" in p;
}

const Conversation = ({ conversation }: ConversationProps) => {
    const { user } = useUser();
    const currentUserEmail = user?.email;

    const setSelectedConversation = useChatStore((s) => s.setSelectedConversation);
    const selectedConversationId = useChatStore((s) => s.selectedConversationId);
    const onlineUsers = useChatStore((s) => s.onlineUsers);

    const otherUser = conversation.participants.find(
        (p): p is ClientUser =>
            isUser(p) && p.email !== currentUserEmail
    );

    const conversationImage =
        conversation.image || otherUser?.profilePicture || "";
    const avatarSrc = conversationImage
        ? getAvatarUrl(conversationImage, 128)
        : undefined;

    const conversationName = conversation.isGroup
        ? conversation.groupName
        : otherUser?.username || "Unknown";

    const avatarFallbackInitial =
        conversationName?.trim().charAt(0).toUpperCase() || "U";

    const lastMessage = conversation.lastMessage;
    const lastMessageType = lastMessage?.messageType;

    const isActive =
        selectedConversationId === String(conversation._id);
    const isDirectOnline = Boolean(
        !conversation.isGroup &&
        otherUser?._id &&
        onlineUsers.includes(String(otherUser._id))
    );

    return (
        <>
            <div
                className={`flex cursor-pointer items-center gap-2 p-3 hover:bg-[hsl(var(--chat-hover))]
          ${isActive ? "bg-[hsl(var(--gray-tertiary))]" : ""}
        `}
                onClick={() => setSelectedConversation(conversation)}
            >
                <Avatar className="relative overflow-visible border border-border">
                    {isDirectOnline && (
                        <div className="absolute top-0 right-0 w-2.5 h-2.5 bg-green-500 rounded-full border-2 border-foreground" />
                    )}
                    <AvatarImage
                        src={avatarSrc}
                        alt={conversationName || "User avatar"}
                        className="object-cover rounded-full"
                    />
                    <AvatarFallback className="bg-muted text-sm font-semibold text-muted-foreground">
                        {avatarFallbackInitial}
                    </AvatarFallback>
                </Avatar>

                <div className="w-full">
                    <div className="flex items-center">
                        <h3 className="text-sm font-medium">
                            {conversationName}
                        </h3>

                        <span className="ml-auto text-xs text-muted-foreground">
                            {formatDate(
                                (conversation?.updatedAt
                                ) ??
                                (conversation.createdAt
                                ) ??
                                Date.now()
                            )}
                        </span>
                    </div>

                    <p className="mt-1 flex items-center gap-1 text-[12px] text-muted-foreground">
                        {lastMessage?.sender?._id === user?._id && <MessageSeenSvg />}
                        {conversation.isGroup && <Users size={16} />}

                        {!lastMessage && "Say Hi!"}

                        {lastMessageType === "text" && lastMessage?.content && (
                            <span>
                                {lastMessage.content.length > 30
                                    ? `${lastMessage.content.slice(0, 30)}...`
                                    : lastMessage.content}
                            </span>
                        )}

                        {lastMessageType === "image" && <ImageIcon size={16} />}
                        {lastMessageType === "video" && <VideoIcon size={16} />}
                    </p>
                </div>
            </div>

            <hr className="mx-10 h-px border-0 bg-border" />
        </>
    );
};

export default Conversation;