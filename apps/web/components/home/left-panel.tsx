"use client";

import { useEffect, useMemo, useState } from "react";
import { ListFilter, LogOut, Search, X } from "lucide-react";
import { Input } from "../ui/input";
import ThemeSwitch from "./theme-switch";
import UserListDialog from "./dialogs/user-list-dialog";
import UserProfile from "./userProfile";
import useChatStore from "@/store/chat-store";
import { ClientUser, ClientConversation } from "@chat/types";
import VirtualConversationList from "../sidebar/VirtualConversationList";
import { socket } from "@/lib/socket/socketClient";
import { useRouter } from "next/navigation";
import { authenticatedFetch } from "@/lib/utils/api";
import { recordApiTiming } from "@/lib/utils/performance";

function isUser(p: unknown): p is ClientUser {
    return typeof p === "object" && p !== null && "username" in p;
}

interface SidebarProps {
    isMobileOpen?: boolean;
    onMobileClose?: () => void;
    initialConversations?: ClientConversation[];
}

const Sidebar = ({
    isMobileOpen = false,
    onMobileClose,
}: SidebarProps) => {
    const conversations = useChatStore((s) => s.conversations);
    const setConversations = useChatStore((s) => s.setConversations);
    const setSelectedConversation = useChatStore((s) => s.setSelectedConversation);
    const router = useRouter();
    const [search, setSearch] = useState("");
    const [debouncedSearch, setDebouncedSearch] = useState("");
    const [loading, setLoading] = useState(true);
    const [fetchError, setFetchError] = useState<string | null>(null);

    // Fetch conversations with explicit cancellation and retry handling.
    useEffect(() => {
        const controller = new AbortController();
        let timeoutId: ReturnType<typeof setTimeout> | null = null;
        let active = true;

        const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

        const isRetryable = (error: unknown) => {
            if (error instanceof DOMException && error.name === "AbortError") {
                return false;
            }

            return error instanceof TypeError || error instanceof SyntaxError || error instanceof Error;
        };

        const fetchConversations = async () => {
            try {
                setLoading(true);
                setFetchError(null);

                timeoutId = setTimeout(() => controller.abort(), 10000);

                let lastError: unknown = null;

                for (let attempt = 0; attempt < 2; attempt += 1) {
                    try {
                        const startedAt = performance.now();
                        const response = await authenticatedFetch("/api/conversations", {
                            signal: controller.signal,
                        });

                        const rawText = await response.text();

                        if (!response.ok) {
                            throw new Error(rawText || `Failed to load conversations (${response.status})`);
                        }

                        const parsed = rawText ? JSON.parse(rawText) : [];
                        const conversations = Array.isArray(parsed) ? parsed : (parsed.conversations ?? []);

                        recordApiTiming("/api/conversations", performance.now() - startedAt);

                        if (!controller.signal.aborted && active) {
                            setConversations(conversations || []);
                        }
                        return;
                    } catch (error) {
                        lastError = error;
                        if (controller.signal.aborted || !isRetryable(error) || attempt === 1) {
                            throw error;
                        }

                        await sleep(250 * (attempt + 1));
                    }
                }

                throw lastError ?? new Error("Failed to load conversations");
            } catch (err) {
                if (controller.signal.aborted || (err instanceof DOMException && err.name === "AbortError")) {
                    return;
                }

                console.error("Failed to fetch conversations:", err);
                setFetchError("Unable to load conversations. Tap to retry.");
            } finally {
                if (timeoutId) clearTimeout(timeoutId);
                if (!controller.signal.aborted && active) {
                    setLoading(false);
                }
            }
        };

        fetchConversations();

        return () => {
            active = false;
            if (timeoutId) clearTimeout(timeoutId);
            controller.abort();
        };
    }, [setConversations]);

    useEffect(() => {
        const handler = setTimeout(() => setDebouncedSearch(search.trim()), 300);
        return () => clearTimeout(handler);
    }, [search]);

    const filteredConversations = useMemo(() => {
        const term = debouncedSearch.toLowerCase();

        const filtered = conversations.filter((conversation) => {
            if (!term) return true;

            if (conversation.isGroup && conversation.groupName?.toLowerCase().includes(term)) {
                return true;
            }

            if (
                conversation.participants?.some(
                    (participant) => isUser(participant) && participant.username.toLowerCase().includes(term)
                )
            ) {
                return true;
            }

            if (conversation.lastMessage?.content?.toLowerCase().includes(term)) {
                return true;
            }

            return false;
        });

        return filtered.sort(
            (a, b) =>
                new Date(b.updatedAt ?? b.createdAt ?? 0).getTime() -
                new Date(a.updatedAt ?? a.createdAt ?? 0).getTime()
        );
    }, [conversations, debouncedSearch]);

    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key !== "Enter" || !debouncedSearch) return;

        const existingDM = conversations.find(
            (conversation) =>
                !conversation.isGroup &&
                conversation.participants?.some(
                    (participant) =>
                        isUser(participant) &&
                        participant.username.toLowerCase().includes(debouncedSearch.toLowerCase())
                )
        );

        if (existingDM) {
            setSelectedConversation(existingDM);
            onMobileClose?.();
        }
    };

    const panelContent = (isMobile = false) => (
        <>
            <div className="flex items-center gap-2 border-b border-[hsl(var(--border))] bg-[hsl(var(--gray-primary))] p-3 sm:p-4">
                <UserProfile />

                <div className="ml-auto flex items-center gap-2 sm:gap-3">
                    <UserListDialog />
                    <ThemeSwitch />

                    <LogOut
                        size={20}
                        className="cursor-pointer text-[hsl(var(--muted-foreground))] transition hover:text-[hsl(var(--foreground))]"
                        onClick={() => {
                            if (socket.connected) {
                                socket.disconnect();
                            }
                            authenticatedFetch("/api/auth/logout", {
                                method: "POST",
                            }).then(() => {
                                router.push("/login");
                            });
                        }}
                    />

                    {isMobile && onMobileClose && (
                        <button
                            type="button"
                            onClick={onMobileClose}
                            className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-[hsl(var(--border))] text-[hsl(var(--muted-foreground))]"
                            aria-label="Close conversations"
                        >
                            <X size={18} />
                        </button>
                    )}
                </div>
            </div>

            <div className="flex items-center border-b border-[hsl(var(--border))] bg-[hsl(var(--gray-primary))] p-2 sm:p-3">
                <div className="relative mx-2 h-10 flex-1 sm:mx-3">
                    <Search
                        className="absolute top-1/2 left-3 -translate-y-1/2 text-[hsl(var(--muted-foreground))]"
                        size={18}
                    />

                    <Input
                        type="text"
                        placeholder="Search or start a new chat"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        onKeyDown={handleKeyDown}
                        className="h-10 w-full rounded-full border border-[hsl(var(--border))] bg-[hsl(var(--input))] py-2 pr-3 pl-10 text-sm text-[hsl(var(--foreground))] shadow-none transition focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))]"
                    />
                </div>

                <ListFilter className="cursor-pointer text-[hsl(var(--muted-foreground))]" />
            </div>

            <div className="custom-scrollbar flex-1 overflow-y-auto bg-[hsl(var(--left-panel))] px-1 pb-4">
                {loading && (
                    <div className="space-y-3 p-3">
                        {[...Array(6)].map((_, i) => (
                            <div
                                key={i}
                                className="h-12 animate-pulse rounded-lg bg-[hsl(var(--gray-secondary))]"
                            />
                        ))}
                    </div>
                )}

                {!loading && fetchError && (
                    <p className="mt-6 text-center text-sm text-red-500">
                        {fetchError}
                    </p>
                )}

                {!loading && !fetchError && filteredConversations.length === 0 && (
                    <div className="mt-6 text-center text-sm text-[hsl(var(--muted-foreground))]">
                        No conversations found
                    </div>
                )}

                <div className="flex-1 overflow-hidden">
                    {!loading && !fetchError && filteredConversations.length > 0 && <VirtualConversationList />}
                </div>
            </div>
        </>
    );

    return (
        <>
            <div
                className={`fixed inset-0 z-40 bg-black/40 transition-opacity duration-300 lg:hidden ${isMobileOpen ? "opacity-100" : "pointer-events-none opacity-0"
                    }`}
                onClick={onMobileClose}
                aria-hidden="true"
            />

            <aside
                className={`fixed inset-0 z-50 flex h-full w-full flex-col border-r border-[hsl(var(--border))] bg-[hsl(var(--left-panel))] text-[hsl(var(--foreground))] shadow-lg transition-transform duration-300 ease-out lg:hidden ${isMobileOpen ? "translate-x-0" : "-translate-x-full"
                    }`}
                role="dialog"
                aria-modal="true"
                aria-label="Conversations"
            >
                {panelContent(true)}
            </aside>

            <aside className="hidden h-full w-80 min-w-[320px] shrink-0 flex-col border-r border-[hsl(var(--border))] bg-[hsl(var(--left-panel))] text-[hsl(var(--foreground))] shadow-lg lg:flex">
                {panelContent(false)}
            </aside>
        </>
    );
};

export default Sidebar;