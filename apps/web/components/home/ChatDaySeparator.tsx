interface ChatDaySeparatorProps {
    date: Date;
}

const ChatDaySeparator = ({ date }: ChatDaySeparatorProps) => {
    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);

    let label = new Intl.DateTimeFormat("en-US", {
        month: "short",
        day: "numeric",
    }).format(date);

    if (date.toDateString() === today.toDateString()) {
        label = "Today";
    } else if (date.toDateString() === yesterday.toDateString()) {
        label = "Yesterday";
    }

    return (
        <div className="text-center my-3">
            <span className="rounded-full bg-muted px-3 py-1 text-xs text-muted-foreground">
                {label}
            </span>
        </div>
    );
};

export default ChatDaySeparator;