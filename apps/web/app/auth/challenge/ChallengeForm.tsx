"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { resetAuthBootstrap } from "@/lib/auth/authBootstrap";
import { useUser } from "@/context/UserContext";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

type ChallengeFormProps = {
    challengeId: string;
    nextPath: string;
    initialVerificationMethod?: "password" | "otp";
};

type ChallengeResponse = {
    success?: boolean;
    error?: string;
    reason?: string;
};

/** Survives Strict Mode remounts and HMR — one auto-send per challenge per tab session. */
const autoOtpSendStarted = new Set<string>();

export default function ChallengeForm({
    challengeId,
    nextPath,
    initialVerificationMethod = "password",
}: ChallengeFormProps) {
    const router = useRouter();
    const { refreshUser } = useUser();
    const [password, setPassword] = useState("");
    const [otp, setOtp] = useState("");
    const [loading, setLoading] = useState(false);
    const [otpLoading, setOtpLoading] = useState(false);
    const [otpSending, setOtpSending] = useState(false);
    const [otpSent, setOtpSent] = useState(false);
    const [otpNotice, setOtpNotice] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const isOtpOnly = initialVerificationMethod === "otp";

    const canSubmitPassword = useMemo(
        () => Boolean(challengeId) && password.trim().length > 0 && !loading,
        [challengeId, password, loading]
    );

    const canSubmitOtp = useMemo(
        () => Boolean(challengeId) && otp.trim().length > 0 && otpSent && !otpLoading,
        [challengeId, otp, otpSent, otpLoading]
    );

    const sendOtpCode = useCallback(async (options?: { manual?: boolean }) => {
        if (!challengeId) {
            setError("Challenge is missing. Please refresh and try again.");
            return false;
        }

        setOtpSending(true);
        setError(null);
        if (!options?.manual) {
            setOtpNotice(null);
        }

        try {
            const response = await fetch("/api/auth/challenge/otp/send", {
                method: "POST",
                credentials: "include",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    challengeId,
                }),
            });

            const payload = (await response.json().catch(() => null)) as ChallengeResponse | null;
            if (!response.ok || !payload?.success) {
                if (response.status === 429) {
                    setError("Too many code requests. Wait a minute, then use Resend code.");
                } else {
                    setError(payload?.reason || payload?.error || "Unable to send OTP. Please try again.");
                }
                return false;
            }

            setOtpSent(true);
            setOtpNotice("We sent a verification code to your email address.");
            return true;
        } catch {
            setError("Unable to send OTP right now. Please try again.");
            return false;
        } finally {
            setOtpSending(false);
        }
    }, [challengeId]);

    useEffect(() => {
        if (!isOtpOnly || !challengeId || otpSent) {
            return;
        }

        if (autoOtpSendStarted.has(challengeId)) {
            return;
        }

        autoOtpSendStarted.add(challengeId);
        void sendOtpCode();
    }, [challengeId, isOtpOnly, otpSent, sendOtpCode]);

    async function onPasswordSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();

        if (!challengeId) {
            setError("Challenge is missing. Please refresh and try again.");
            return;
        }

        setLoading(true);
        setError(null);

        try {
            const response = await fetch("/api/auth/challenge/password", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    challengeId,
                    password,
                }),
            });

            const payload = (await response.json().catch(() => null)) as ChallengeResponse | null;
            if (!response.ok || !payload?.success) {
                if (payload?.reason === "Password authentication not available for this account") {
                    const sent = await sendOtpCode();
                    if (sent) {
                        setError("This account uses OTP verification. Enter the code sent to your email.");
                    }
                    return;
                }

                setError(payload?.reason || payload?.error || "Verification failed. Please try again.");
                return;
            }

            resetAuthBootstrap();
            await refreshUser();
            router.replace(nextPath || "/dashboard");
        } catch {
            setError("Unable to verify right now. Please try again.");
        } finally {
            setLoading(false);
        }
    }

    async function onOtpSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();

        if (!challengeId) {
            setError("Challenge is missing. Please refresh and try again.");
            return;
        }

        setOtpLoading(true);
        setError(null);

        try {
            const response = await fetch("/api/auth/challenge/otp/verify", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    challengeId,
                    otp,
                }),
            });

            const payload = (await response.json().catch(() => null)) as ChallengeResponse | null;
            if (!response.ok || !payload?.success) {
                setError(payload?.reason || payload?.error || "Verification failed. Please try again.");
                return;
            }

            resetAuthBootstrap();
            await refreshUser();
            router.replace(nextPath || "/dashboard");
        } catch {
            setError("Unable to verify right now. Please try again.");
        } finally {
            setOtpLoading(false);
        }
    }

    return (
        <div className="space-y-6">
            {!isOtpOnly ? (
                <form className="space-y-4" onSubmit={onPasswordSubmit}>
                    <div className="space-y-2">
                        <label className="text-sm font-medium text-[hsl(var(--foreground))]" htmlFor="step-up-password">
                            Password
                        </label>
                        <Input
                            id="step-up-password"
                            type="password"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            autoComplete="current-password"
                            placeholder="Enter your password"
                            disabled={loading || otpLoading || otpSending}
                            required
                        />
                    </div>

                    <Button className="w-full" type="submit" disabled={!canSubmitPassword}>
                        {loading ? "Verifying..." : "Verify with password"}
                    </Button>
                </form>
            ) : null}

            <div className="rounded-lg border border-dashed border-[hsl(var(--border))] p-4 space-y-4">
                <div>
                    <p className="text-sm font-medium text-[hsl(var(--foreground))]">Use a one-time code</p>
                    <p className="mt-1 text-sm text-[hsl(var(--muted-foreground))]">
                        {isOtpOnly
                            ? "This account uses OTP verification. A code will be sent to your email, and you can request another if needed."
                            : "If this account uses Google sign-in, request a code sent to your email."}
                    </p>
                </div>

                <Button
                    className="w-full"
                    type="button"
                    variant="secondary"
                    onClick={() => void sendOtpCode({ manual: true })}
                    disabled={otpSending || loading || otpLoading || !challengeId}
                >
                    {otpSending ? "Sending code..." : otpSent ? "Resend code" : "Send code"}
                </Button>

                {otpSent ? (
                    <form className="space-y-4" onSubmit={onOtpSubmit}>
                        <div className="space-y-2">
                            <label className="text-sm font-medium text-[hsl(var(--foreground))]" htmlFor="step-up-otp">
                                Verification code
                            </label>
                            <Input
                                id="step-up-otp"
                                inputMode="numeric"
                                value={otp}
                                onChange={(e) => setOtp(e.target.value)}
                                autoComplete="one-time-code"
                                placeholder="Enter the 6-digit code"
                                disabled={otpLoading || loading}
                                required
                            />
                        </div>

                        <Button className="w-full" type="submit" disabled={!canSubmitOtp}>
                            {otpLoading ? "Verifying..." : "Verify code"}
                        </Button>
                    </form>
                ) : null}
            </div>

            {otpNotice ? (
                <p className="text-sm text-[hsl(var(--foreground))]" role="status">
                    {otpNotice}
                </p>
            ) : null}

            {error ? (
                <p className="text-sm text-red-600" role="alert">
                    {error}
                </p>
            ) : null}
        </div>
    );
}
