import { NextResponse } from "next/server";
import { connectToDatabase } from "@/lib/Db/db";
import { StepUpChallenge } from "@/models/StepUpChallenge";
import {
    getInternalSecret,
    hasValidInternalSecret,
    INTERNAL_SECRET_HEADER,
} from "@chat/types/utils/internal-bridge-auth";

type StepUpStatusBody = {
    userId?: string;
};

function deny(reason: string, status = 403) {
    return NextResponse.json({ requiresStepUp: false, reason }, { status });
}

export async function POST(req: Request) {
    const providedSecret = req.headers.get(INTERNAL_SECRET_HEADER);
    if (!hasValidInternalSecret(providedSecret, getInternalSecret())) {
        return deny("unauthorized_internal_request", 401);
    }

    let body: StepUpStatusBody;
    try {
        body = (await req.json()) as StepUpStatusBody;
    } catch {
        return deny("invalid_json", 400);
    }

    if (!body.userId || typeof body.userId !== "string") {
        return deny("invalid_payload", 400);
    }

    await connectToDatabase();

    const challenge = await StepUpChallenge.findOne({
        userId: body.userId,
        status: "pending",
        expiresAt: { $gt: new Date() },
    })
        .sort({ createdAt: -1 })
        .select("_id verificationMethod")
        .lean<{ _id: { toString(): string }; verificationMethod: "password" | "otp" } | null>();

    if (!challenge) {
        return NextResponse.json({ requiresStepUp: false });
    }

    return NextResponse.json({
        requiresStepUp: true,
        challengeId: challenge._id.toString(),
        verificationMethod: challenge.verificationMethod,
    });
}
