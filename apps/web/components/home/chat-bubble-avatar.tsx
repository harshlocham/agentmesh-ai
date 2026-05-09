import { Avatar, AvatarFallback, AvatarImage } from "../ui/avatar";
import { ClientUser } from "@chat/types";

type ChatBubbleAvatarProps = {
    sender: ClientUser;
    isMember: boolean;
    isGroup: boolean | undefined;
};

const ChatBubbleAvatar = ({ isGroup, isMember, sender }: ChatBubbleAvatarProps) => {
    if (!isGroup) return null;

    return (
        <Avatar className='overflow-visible relative'>
            {sender.isOnline && isMember && (
                <div className='absolute top-0 right-0 w-2 h-2 bg-green-500 rounded-full border-2 border-foreground' />
            )}
            <AvatarImage src={sender?.profilePicture} className='rounded-full object-cover w-8 h-8' />
            <AvatarFallback className='w-8 h-8 '>
                <div className="h-8 w-8 animate-pulse rounded-full bg-[hsl(var(--gray-tertiary))]" />
            </AvatarFallback>
        </Avatar>
    );
};
export default ChatBubbleAvatar;