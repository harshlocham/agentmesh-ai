import { Lock } from "lucide-react";
import Image from "next/image";
import { Button } from "../ui/button";

const ChatPlaceHolder = () => {
    return (
        <div className="w-full max-w-3xl mx-auto flex flex-col items-center justify-center py-16 px-4 bg-[hsl(var(--card))] border border-[hsl(var(--border))] rounded-2xl shadow-lg min-h-[400px] text-[hsl(var(--foreground))]">
            <div className="flex flex-col items-center w-full justify-center gap-6">
                <Image src="/desktop-hero.png" alt="Hero" width={320} height={120} className="opacity-90" />
                <p className="text-2xl sm:text-3xl font-light mt-2 mb-1 text-center">Welcome to your workspace</p>
                <p className="max-w-md text-center text-base text-muted-foreground">
                    Select a conversation or start a new one to begin chatting.<br />Your messages are secure, real-time, and private.
                </p>
                <Button className="mt-2 rounded-full px-6 py-2 shadow" onClick={() => window.location.reload()}>
                    Start a Conversation
                </Button>
            </div>
            <p className="mt-10 flex items-center justify-center gap-1 text-center text-xs text-muted-foreground">
                <Lock size={12} /> End-to-end encrypted &amp; private
            </p>
        </div>
    );
};
export default ChatPlaceHolder;