import ChallengeForm from "./ChallengeForm";
import { connectToDatabase } from "@/lib/Db/db";
import { StepUpChallenge } from "@/models/StepUpChallenge";
import { User } from "@/models/User";

type ChallengePageProps = {
    searchParams?: Promise<{
        cid?: string;
        next?: string;
    }>;
};

function sanitizeNextPath(nextPath?: string): string {
    if (!nextPath || typeof nextPath !== "string") {
        return "/dashboard";
    }

    if (!nextPath.startsWith("/") || nextPath.startsWith("//")) {
        return "/dashboard";
    }

    return nextPath;
}

async function getInitialVerificationMethod(challengeId: string): Promise<"password" | "otp"> {
    if (!challengeId) {
        return "password";
    }

    await connectToDatabase();

    const challenge = await StepUpChallenge.findById(challengeId)
        .select("userId")
        .lean<{ userId: string } | null>();

    if (!challenge?.userId) {
        return "password";
    }

    const user = await User.findById(challenge.userId)
        .select("authProviders")
        .lean<{ authProviders?: Array<"password" | "google"> } | null>();

    const providers = Array.isArray(user?.authProviders) ? user.authProviders : [];
    return providers.includes("password") ? "password" : "otp";
}

export default async function ChallengePage({ searchParams }: ChallengePageProps) {
    const resolvedSearchParams = (await searchParams) ?? {};
    const challengeId = resolvedSearchParams.cid || "";
    const nextPath = sanitizeNextPath(resolvedSearchParams.next);
    const initialVerificationMethod = await getInitialVerificationMethod(challengeId);

    return (
        <main className="min-h-screen bg-[hsl(var(--background))] px-4 py-10 sm:px-6">
            <div className="mx-auto w-full max-w-md rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-6 shadow-sm sm:p-8">
                <h1 className="text-xl font-semibold text-[hsl(var(--foreground))] sm:text-2xl">
                    Step-up verification
                </h1>
                <p className="mt-2 text-sm text-[hsl(var(--muted-foreground))]">
                    We detected unusual activity. Please verify your identity.
                </p>

                <div className="mt-6">
                    <ChallengeForm
                        challengeId={challengeId}
                        nextPath={nextPath}
                        initialVerificationMethod={initialVerificationMethod}
                    />
                </div>
            </div>
        </main>
    );
}
