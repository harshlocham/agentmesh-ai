/**
 * AppShell skeleton for immediate rendering
 * Shows layout structure instantly while data loads
 */

export function AppShellSkeleton() {
    return (
        <div className="flex h-screen bg-background">
            {/* Sidebar skeleton */}
            <div className="w-80 border-r border-border flex flex-col">
                {/* Header section */}
                <div className="flex items-center gap-2 p-4 border-b border-border">
                    <div className="w-12 h-12 rounded-lg bg-muted animate-pulse" />
                    <div className="flex-1 space-y-2">
                        <div className="h-4 w-24 bg-muted rounded animate-pulse" />
                        <div className="h-3 w-16 bg-muted rounded animate-pulse" />
                    </div>
                </div>

                {/* Search bar skeleton */}
                <div className="px-4 py-3 border-b border-border">
                    <div className="h-10 bg-muted rounded-lg animate-pulse" />
                </div>

                {/* Conversations list skeleton */}
                <div className="flex-1 overflow-hidden">
                    {[...Array(6)].map((_, i) => (
                        <div key={i} className="px-2 py-2 border-b border-border last:border-b-0">
                            <div className="flex items-center gap-3 p-2">
                                <div className="w-12 h-12 rounded-lg bg-muted animate-pulse flex-shrink-0" />
                                <div className="flex-1 min-w-0 space-y-2">
                                    <div className="h-4 w-32 bg-muted rounded animate-pulse" />
                                    <div className="h-3 w-24 bg-muted rounded animate-pulse" />
                                </div>
                            </div>
                        </div>
                    ))}
                </div>

                {/* Footer section */}
                <div className="px-4 py-4 border-t border-border space-y-2">
                    <div className="h-10 bg-muted rounded-lg animate-pulse" />
                </div>
            </div>

            {/* Main chat area skeleton */}
            <div className="flex-1 flex flex-col">
                {/* Chat header skeleton */}
                <div className="h-16 border-b border-border px-6 flex items-center justify-between">
                    <div className="space-y-2">
                        <div className="h-4 w-48 bg-muted rounded animate-pulse" />
                        <div className="h-3 w-32 bg-muted rounded animate-pulse" />
                    </div>
                    <div className="flex gap-2">
                        {[...Array(3)].map((_, i) => (
                            <div key={i} className="w-10 h-10 rounded-lg bg-muted animate-pulse" />
                        ))}
                    </div>
                </div>

                {/* Messages area skeleton */}
                <div className="flex-1 overflow-hidden p-6 space-y-4">
                    {[...Array(5)].map((_, i) => (
                        <div key={i} className={`flex ${i % 2 === 0 ? 'justify-start' : 'justify-end'}`}>
                            <div
                                className={`max-w-xs ${i % 2 === 0 ? 'bg-muted' : 'bg-primary/20'
                                    } rounded-lg p-3 space-y-2 animate-pulse`}
                            >
                                <div className="h-4 w-40 bg-current opacity-20 rounded" />
                                <div className="h-3 w-32 bg-current opacity-20 rounded" />
                            </div>
                        </div>
                    ))}
                </div>

                {/* Message input skeleton */}
                <div className="h-20 border-t border-border px-6 py-4 flex gap-2">
                    <div className="flex-1 bg-muted rounded-lg animate-pulse" />
                    <div className="w-10 h-10 bg-muted rounded-lg animate-pulse flex-shrink-0" />
                </div>
            </div>
        </div>
    );
}

/**
 * Minimal shell that loads instantly
 * No data required, just structure
 */
export function MinimalAppShell({ children }: { children: React.ReactNode }) {
    return (
        <div className="flex h-screen bg-background">
            {/* Sidebar container - loaded via Suspense */}
            <div className="w-80 border-r border-border flex flex-col">
                {children}
            </div>

            {/* Main area - loaded via Suspense */}
            <div className="flex-1 flex flex-col bg-background">
                {/* Placeholder while content loads */}
            </div>
        </div>
    );
}
