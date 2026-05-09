"use client";
import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "../../ui/input";
import { Button } from "../../ui/button";
import { ImageIcon, MessageSquareDiff } from "lucide-react";
import Image from "next/image";
import toast from "react-hot-toast";
import useChatStore from "@/store/chat-store";
import { getMe, getUsers, createConversation } from "@/lib/utils/api";
import { useEffect, useRef, useState } from "react";
import { UserItem } from "./UserItem";
import { upload } from "@imagekit/next";
import { ClientUser } from "@chat/types";
import { ClientConversation } from "@chat/types";
import { getImageKitUploadAuth } from "@/lib/utils/imagekit";

const UserListDialog = () => {
    const [selectedUsers, setSelectedUsers] = useState<string[]>([]);
    const [groupName, setGroupName] = useState("");
    const [selectedImage, setSelectedImage] = useState<File | null>(null);
    const [renderedImage, setRenderedImage] = useState("");
    const [users, setUsers] = useState<ClientUser[]>([]);
    const [me, setMe] = useState<ClientUser>();
    const [isLoading, setIsLoading] = useState(false);

    const dialogCloseRef = useRef<HTMLButtonElement>(null);
    const setSelectedConversation = useChatStore((s) => s.setSelectedConversation);

    // 🔁 Load users
    useEffect(() => {
        const fetchData = async () => {
            try {
                const [meData, allUsers] = await Promise.all([getMe(), getUsers()]);
                setMe(meData);
                setUsers(allUsers.filter((u: ClientUser) => u._id !== meData._id));
            } catch {
                toast.error("Failed to load users");
            }
        };
        fetchData();
    }, []);

    // 🖼️ Render preview
    useEffect(() => {
        if (!selectedImage) return setRenderedImage("");
        const reader = new FileReader();
        reader.onload = (e) => setRenderedImage(e.target?.result as string);
        reader.readAsDataURL(selectedImage);
    }, [selectedImage]);

    // 📤 Upload to ImageKit
    const uploadToImageKit = async (file: File) => {
        const auth = await getImageKitUploadAuth();

        const result = await upload({
            file,
            fileName: file.name,
            publicKey: auth.publicKey,
            signature: auth.signature,
            token: auth.token,
            expire: auth.expire,
            folder: "chat-group-images",
        });
        return result; // usable image URL
    };

    // ➕ Create conversation
    const handleCreateConversation = async () => {
        if (!me?._id || selectedUsers.length === 0) return;
        setIsLoading(true);

        try {
            const isGroup = selectedUsers.length > 1;
            let imageUrl: string | undefined;

            if (isGroup && selectedImage) {
                const res = await uploadToImageKit(selectedImage);
                imageUrl = res.url;
            }

            const conversationId = await createConversation({
                participants: [...selectedUsers, String(me._id)],
                isGroup,
                admin: isGroup ? String(me._id) : undefined,
                groupName: isGroup ? groupName : undefined,
                image: isGroup ? imageUrl : undefined,
            });

            const matchedUsers = selectedUsers
                .map((id) => users.find((u) => String(u._id) === String(id)))
                .filter(Boolean) as ClientUser[];

            const participants = [
                ...matchedUsers,
                me,
            ];

            const otherUser = matchedUsers[0];
            const conversationName = isGroup ? groupName : (otherUser?.username || otherUser?.email || "");

            const newConversation: ClientConversation = {
                _id: conversationId,
                participants,
                isGroup,
                image: isGroup ? imageUrl : otherUser?.profilePicture,
                name: conversationName,
                groupName: isGroup ? groupName : undefined,
                admin: String(me._id),
                type: isGroup ? "group" : "direct",
                createdAt: String(new Date()),
                updatedAt: String(new Date()),
                lastMessage: undefined,
            };


            // Fix: Ensure newConversation is of type IConversation
            setSelectedConversation(newConversation);
            dialogCloseRef.current?.click();

            setSelectedUsers([]);
            setGroupName("");
            setSelectedImage(null);

            toast.success("Conversation created successfully");
        } catch (error) {
            console.log("Failed to create conversation", error);
            toast.error("Failed to create conversation");
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <Dialog>
            <DialogTrigger>
                <MessageSquareDiff size={20} />
            </DialogTrigger>
            <DialogContent className="sm:max-w-106.25 bg-[hsl(var(--card))] shadow-xl rounded-xl">
                <DialogHeader>
                    <DialogClose ref={dialogCloseRef} />
                    <DialogTitle>Users</DialogTitle>
                </DialogHeader>
                <DialogDescription>Start a new chat</DialogDescription>

                {renderedImage && (
                    <div className="w-16 h-16 relative mx-auto">
                        <Image src={renderedImage} fill alt="Group Image" className="rounded-full object-cover" />
                    </div>
                )}

                {selectedUsers.length > 1 && (
                    <>
                        <Input
                            value={groupName}
                            onChange={(e) => setGroupName(e.target.value)}
                            placeholder="Group name"
                        />
                        <input
                            type="file"
                            accept="image/*"
                            className="hidden"
                            id="group-image-input"
                            onChange={(e) => setSelectedImage(e.target.files?.[0] || null)}
                        />
                        <Button
                            className="flex gap-2"
                            onClick={() => document.getElementById("group-image-input")?.click()}
                        >
                            <ImageIcon size={20} />
                            Upload Group Image
                        </Button>
                    </>
                )}

                <div className="flex flex-col gap-3 overflow-auto max-h-60 ">
                    {users.map((user) => (
                        <UserItem
                            key={String(user._id)}
                            user={user}
                            selected={selectedUsers.includes(String(user._id))} // 👈 selectedUsers is a string array
                            onClick={() =>
                                setSelectedUsers((prev) =>
                                    prev.includes(String(user._id))
                                        ? prev.filter((id) => id !== String(user._id))
                                        : [...prev, String(user._id)]
                                )
                            }
                        />
                    ))}
                </div>

                <div className="flex justify-between">
                    <DialogClose asChild>
                        <Button variant="outline">Cancel</Button>
                    </DialogClose>
                    <Button
                        onClick={handleCreateConversation}
                        disabled={
                            selectedUsers.length === 0 ||
                            (selectedUsers.length > 1 && !groupName) ||
                            isLoading
                        }
                    >
                        {isLoading ? (
                            <div className="w-5 h-5 border-t-2 border-b-2 rounded-full animate-spin" />
                        ) : (
                            "Create"
                        )}
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    );
};

export default UserListDialog;
