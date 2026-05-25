// src/app/admin/page.tsx
"use client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Charts } from "@/components/admin/Charts";
import { useEffect, useState } from "react";
import { io } from "socket.io-client";
import { useRouter } from "next/navigation";
import { getClientSocketUrl } from "@/lib/socket/socketConfig";
import { useUser } from "@/context/UserContext";
import Link from "next/link";


export default function AdminDashboard() {
    const [stats, setStats] = useState({ activeUsers: 0, totalMessagesToday: 0 });
    const { user, isLoading } = useUser();
    const router = useRouter();
    useEffect(() => {
        if (isLoading) return;
        if (!user || user.role !== "admin") {
            router.replace("/"); // redirect non-admins
        }
    }, [user, isLoading, router])
    useEffect(() => {
        const socket = io(getClientSocketUrl(), {
            path: "/api/socket",
            autoConnect: true, // you control when to connect
            transports: ["websocket"], // prefer ws
            withCredentials: true,
        });

        socket.on("connect", () => {
            console.log("✅ Connected to socket:", socket.id);
            socket.emit("admin:join");
        });

        socket.on("connect_error", (err) => {
            console.error("❌ Connection failed:", err.message);
        });

        socket.on("dashboard:init", (data) => {
            setStats(data);
            console.log("📊 Initial stats:", data);
        });

        socket.on("dashboard:update", (data) => {
            setStats((prev) => ({ ...prev, ...data }));
            console.log("📈 Update received:", data);
        });

        return () => {
            socket.disconnect();
        };
    }, [user]);
    console.log(stats);
    return (
        <div className="space-y-6 bg-[hsl(var(--gray-primary)]">
            {/* Top Stats */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 bg-[hsl(var(--gray-primary)]">
                <Card>
                    <CardHeader>
                        <CardTitle>Active Users</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <p className="text-2xl font-bold">{stats.activeUsers}</p>
                        <p className="text-sm text-muted-foreground">+5% from last week</p>
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader>
                        <CardTitle>Messages Today</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <p className="text-2xl font-bold">{stats.totalMessagesToday}</p>
                        <p className="text-sm text-muted-foreground">+12% from yesterday</p>
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader>
                        <CardTitle>Open Reports</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <p className="text-2xl font-bold">23</p>
                        <p className="text-sm text-muted-foreground">Need review</p>
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader>
                        <CardTitle>Security</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <p className="text-sm text-muted-foreground">Review authentication activity and anomalies.</p>
                        <Link href="/admin/auth-events" className="mt-3 inline-block text-sm font-semibold underline">
                            Open Auth Events
                        </Link>
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader>
                        <CardTitle>Execution Governance</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <p className="text-sm text-muted-foreground">Review pending AI execution requests and approve or reject them.</p>
                        <Link href="/admin/task-approvals" className="mt-3 inline-block text-sm font-semibold underline">
                            Open Task Approvals Queue
                        </Link>
                    </CardContent>
                </Card>
            </div>

            {/* Charts Section */}
            <Charts />
        </div>
    );
}