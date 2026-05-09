import { Lock } from "lucide-react";
import Image from "next/image";
import { Button } from "../ui/button";

const ChatPlaceHolder = () => {
    return (
        <div className="mx-auto flex min-h-[400px] w-full max-w-3xl flex-col items-center justify-center rounded-2xl border border-border bg-card px-4 py-16 text-card-foreground shadow-lg">
            <div className="flex w-full flex-col items-center justify-center gap-6">
                <Image src="/desktop-hero.png" alt="Hero" width={320} height={120} className="opacity-90" />
                <p className="mt-2 mb-1 text-center text-2xl font-light sm:text-3xl">Welcome to your workspace</p>
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
