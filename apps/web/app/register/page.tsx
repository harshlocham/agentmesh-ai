"use client";

import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useRouter } from "next/navigation";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
    Card,
    CardContent,
    CardDescription,
    CardFooter,
    CardHeader,
    CardTitle,
} from "@/components/ui/card";
import { Loader2, RefreshCcw } from "lucide-react";
import { Label } from "@/components/ui/label";
import ThemeSwitch from "@/components/home/theme-switch";
import { toast } from "sonner";
import { resetAuthBootstrap } from "@/lib/auth/authBootstrap";
import { useUser } from "@/context/UserContext";

export default function RegisterPage() {
    const [step, setStep] = useState<"register" | "verify">("register");
    const [name, setName] = useState("");
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [otp, setOtp] = useState("");
    const [loading, setLoading] = useState(false);
    const [timer, setTimer] = useState(0);

    const router = useRouter();
    const { refreshUser } = useUser();

    useEffect(() => {
        let interval: NodeJS.Timeout | null = null;
        if (timer > 0) {
            interval = setInterval(() => setTimer((t) => t - 1), 1000);
        }
        return () => {
            if (interval) clearInterval(interval);
        };
    }, [timer]);

    async function sendOtp() {
        setLoading(true);
        try {
            const res = await fetch("/api/auth/sendOtp", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ email: email.trim() }),
            });

            if (!res.ok) {
                const data = await res.json().catch(() => null);
                throw new Error(data?.error || "Failed to send OTP");
            }

            setStep("verify");
            setTimer(60);
            toast.success("OTP sent to your email");
        } catch (error) {
            if (error instanceof Error) {
                toast.error(error.message);
            } else {
                toast.error("Failed to send OTP");
            }
        } finally {
            setLoading(false);
        }
    }

    async function handleRegister(e: React.FormEvent<HTMLFormElement>) {
        e.preventDefault();

        if (!name.trim() || !email.trim() || !password.trim()) {
            toast.error("Please fill all fields");
            return;
        }

        if (password.trim().length < 6) {
            toast.error("Password must be at least 6 characters");
            return;
        }

        await sendOtp();
    }

    async function handleVerify(e: React.FormEvent<HTMLFormElement>) {
        e.preventDefault();

        if (otp.trim().length < 6) {
            toast.error("Enter the 6-digit OTP");
            return;
        }

        setLoading(true);
        try {
            const res = await fetch("/api/auth/verify-otp", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    email: email.trim(),
                    otp: otp.trim(),
                    name: name.trim(),
                    password,
                }),
            });

            if (!res.ok) {
                const data = await res.json().catch(() => null);
                throw new Error(data?.error || "Invalid or expired OTP");
            }

            const loginRes = await fetch("/api/auth/login", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    email: email.trim(),
                    password,
                }),
            });

            if (!loginRes.ok) {
                const data = await loginRes.json().catch(() => null);
                throw new Error(data?.error || "Login failed after verification");
            }

            resetAuthBootstrap();
            const me = await refreshUser();
            if (!me) {
                throw new Error("Session could not be loaded. Try signing in.");
            }

            toast.success("Account created successfully");
            router.push("/");
        } catch (error) {
            if (error instanceof Error) {
                toast.error(error.message);
            } else {
                toast.error("Something went wrong");
            }
        } finally {
            setLoading(false);
        }
    }

    return (
        <div className="relative min-h-screen overflow-hidden bg-[hsl(var(--background))] px-4 py-8 sm:px-6">
            <div className="pointer-events-none absolute inset-0">
                <div className="absolute right-0 top-12 h-72 w-72 rounded-full bg-cyan-400/10 blur-3xl" />
                <div className="absolute -bottom-20 left-1/2 h-80 w-80 -translate-x-1/2 rounded-full bg-blue-500/10 blur-3xl" />
            </div>

            <div className="relative mx-auto flex min-h-[calc(100vh-4rem)] w-full max-w-md items-center">
                <Card className="w-full border-[hsl(var(--border))]/70 bg-[hsl(var(--card))/0.94] shadow-2xl shadow-black/25 backdrop-blur-sm">
                    <CardHeader className="gap-5">
                        <div className="flex items-center justify-between gap-3">
                            <div className="rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))/0.45] px-3 py-1.5 text-sm text-[hsl(var(--muted-foreground))]">
                                Already have an account?
                                <Button
                                    variant="link"
                                    className="h-auto px-2 py-0 text-sm font-medium"
                                    onClick={() => router.push("/login")}
                                >
                                    Login
                                </Button>
                            </div>
                            <ThemeSwitch />
                        </div>

                        <div className="space-y-2">
                            <CardTitle className="max-w-sm text-3xl font-semibold leading-[1.05] tracking-tight sm:text-4xl">
                                {step === "register" ? "Create your account" : "Verify your email"}
                            </CardTitle>
                            <CardDescription className="max-w-md text-sm leading-6 sm:text-base">
                                {step === "register"
                                    ? "Set up your account to start chatting instantly."
                                    : "Enter the one-time code we sent to your email."}
                            </CardDescription>
                        </div>
                    </CardHeader>

                    <CardContent>
                        <AnimatePresence mode="wait">
                            {step === "register" ? (
                                <motion.form
                                    key="register"
                                    initial={{ opacity: 0, y: 12 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    exit={{ opacity: 0, y: -12 }}
                                    transition={{ duration: 0.2 }}
                                    className="space-y-4"
                                    onSubmit={handleRegister}
                                >
                                    <div className="grid gap-2">
                                        <Label htmlFor="name">Full Name</Label>
                                        <Input
                                            id="name"
                                            placeholder="John Doe"
                                            value={name}
                                            onChange={(e) => setName(e.target.value)}
                                            className="h-11"
                                            autoComplete="name"
                                            disabled={loading}
                                            required
                                        />
                                    </div>

                                    <div className="grid gap-2">
                                        <Label htmlFor="register-email">Email</Label>
                                        <Input
                                            id="register-email"
                                            type="email"
                                            placeholder="you@example.com"
                                            value={email}
                                            onChange={(e) => setEmail(e.target.value)}
                                            className="h-11"
                                            autoComplete="email"
                                            disabled={loading}
                                            required
                                        />
                                    </div>

                                    <div className="grid gap-2">
                                        <Label htmlFor="register-password">Password</Label>
                                        <Input
                                            id="register-password"
                                            type="password"
                                            placeholder="At least 6 characters"
                                            value={password}
                                            onChange={(e) => setPassword(e.target.value)}
                                            className="h-11"
                                            autoComplete="new-password"
                                            disabled={loading}
                                            required
                                        />
                                    </div>

                                    <Button
                                        type="submit"
                                        className="h-11 w-full"
                                        disabled={loading || !email.trim() || !password.trim() || !name.trim()}
                                    >
                                        {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                                        Send OTP
                                    </Button>
                                </motion.form>
                            ) : (
                                <motion.form
                                    key="verify"
                                    initial={{ opacity: 0, y: 12 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    exit={{ opacity: 0, y: -12 }}
                                    transition={{ duration: 0.2 }}
                                    className="space-y-4"
                                    onSubmit={handleVerify}
                                >
                                    <div className="rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--background))/0.45] px-3 py-2 text-sm text-[hsl(var(--muted-foreground))]">
                                        Code sent to <span className="font-medium text-[hsl(var(--foreground))]">{email}</span>
                                    </div>

                                    <div className="grid gap-2">
                                        <Label htmlFor="otp">One-Time Password</Label>
                                        <Input
                                            id="otp"
                                            maxLength={6}
                                            placeholder="000000"
                                            className="h-11 text-center text-lg tracking-[0.35em]"
                                            value={otp}
                                            onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))}
                                            inputMode="numeric"
                                            autoComplete="one-time-code"
                                            disabled={loading}
                                            required
                                        />
                                    </div>

                                    <Button
                                        type="submit"
                                        className="h-11 w-full"
                                        disabled={loading || otp.trim().length < 6}
                                    >
                                        {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                                        Verify & Login
                                    </Button>

                                    <div className="flex flex-wrap items-center justify-between gap-2 pt-1 text-sm">
                                        <Button
                                            type="button"
                                            variant="link"
                                            className="h-auto px-0"
                                            onClick={() => {
                                                setStep("register");
                                                setOtp("");
                                            }}
                                        >
                                            Edit details
                                        </Button>

                                        {timer > 0 ? (
                                            <span className="text-[hsl(var(--muted-foreground))]">
                                                Resend OTP in {timer}s
                                            </span>
                                        ) : (
                                            <Button
                                                type="button"
                                                variant="link"
                                                className="h-auto px-0"
                                                onClick={sendOtp}
                                                disabled={loading}
                                            >
                                                <RefreshCcw className="mr-1 h-4 w-4" />
                                                Resend OTP
                                            </Button>
                                        )}
                                    </div>
                                </motion.form>
                            )}
                        </AnimatePresence>
                    </CardContent>

                    <CardFooter className="text-xs leading-6 text-[hsl(var(--muted-foreground))]">
                        We protect your account with email verification before first login.
                    </CardFooter>
                </Card>
            </div>
        </div>
    );
}