'use client'

const EMOJIS = ["👍", "❤️", "😂", "😮", "😢", "🔥"];

export function ReactionBar({ onSelect }: { onSelect: (emoji: string) => void }) {
    return (
        <div className="absolute -bottom-8 right-0 flex gap-1 rounded-full border border-border bg-popover px-2 py-1 shadow-md">
            {EMOJIS.map((emoji) => (
                <button
                    key={emoji}
                    className="hover:scale-125 transition-transform text-lg"
                    onClick={() => onSelect(emoji)}
                >
                    {emoji}
                </button>
            ))}
        </div>
    );
}