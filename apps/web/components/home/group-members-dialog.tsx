import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from "@/components/ui/dialog";
import { Avatar, AvatarFallback, AvatarImage } from "../ui/avatar";
import { Crown } from "lucide-react";
import useChatStore from "@/store/chat-store";

const GroupMembersDialog = () => {
    const selectedConversation = useChatStore((s) => s.selectedConversation);
    const members = selectedConversation?.participants || [];

    return (
        <Dialog>
            <DialogTrigger>
                <p className="text-xs text-muted-foreground text-left hover:underline cursor-pointer">
                    See members
                </p>
            </DialogTrigger>
            <DialogContent className="sm:max-w-[425px] bg-[hsl(var(--card))] rounded-xl shadow-lg">
                <DialogHeader>
                    <DialogTitle className="my-2 text-lg font-semibold">
                        Current Members
                    </DialogTitle>
                </DialogHeader>

                <div className="flex flex-col gap-2 mt-2">
                    {members.map((user) => (

                        <div
                            key={String(user._id)}
                            className="flex items-center gap-3 p-2 rounded-lg hover:bg-[hsl(var(--gray-secondary))] transition"
                        >
                            <div className="relative">
                                <Avatar className="h-10 w-10">
                                    <AvatarImage
                                        src={user.profilePicture}
                                        className="rounded-full object-cover"
                                    />
                                    <AvatarFallback>
                                        <div className="animate-pulse bg-[hsl(var(--gray-primary))] w-full h-full rounded-full"></div>
                                    </AvatarFallback>
                                </Avatar>
                                {user.isOnline && (
                                    <span className="absolute bottom-0 right-0 w-3 h-3 bg-green-500 rounded-full border-2 border-[hsl(var(--card))]" />
                                )}
                            </div>

                            <div className="flex-1">
                                <div className="flex items-center gap-2">
                                    <h3 className="text-sm font-medium">
                                        {user.username || user.email.split("@")[0]}
                                    </h3>
                                    {selectedConversation!.admin === String(user._id) && (
                                        <Crown size={16} className="text-yellow-500" />
                                    )}
                                </div>
                                <p className="text-xs text-muted-foreground">
                                    {user.email}
                                </p>
                            </div>
                        </div>
                    ))}
                </div>
            </DialogContent>
        </Dialog>
    );
};

export default GroupMembersDialog;