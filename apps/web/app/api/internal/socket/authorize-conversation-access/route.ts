import { NextResponse } from "next/server";
import {
    assertConversationAccess,
    AuthorizationError,
} from "@chat/services/authorization.service";
import {
    getInternalSecret,
    hasValidInternalSecret,
    INTERNAL_SECRET_HEADER,
} from "@chat/types/utils/internal-bridge-auth";

type AuthorizeConversationAccessBody = {
    userId?: string;
    conversationId?: string;
    userRole?: "user" | "moderator" | "admin";
};

function deny(reason: string, status = 403) {
    return NextResponse.json({ allowed: false, reason }, { status });
}

export async function POST(req: Request) {
    const providedSecret = req.headers.get(INTERNAL_SECRET_HEADER);
    if (!hasValidInternalSecret(providedSecret, getInternalSecret())) {
        return deny("unauthorized_internal_request", 401);
    }

    let body: AuthorizeConversationAccessBody;
    try {
        body = (await req.json()) as AuthorizeConversationAccessBody;
    } catch {
        return deny("invalid_json", 400);
    }

    const { userId, conversationId, userRole } = body;
    if (!userId || !conversationId) {
        return deny("invalid_payload", 400);
    }

    try {
        const access = await assertConversationAccess(userId, conversationId, {
            userRole: userRole ?? "user",
            allowAdminBypass: true,
        });

        return NextResponse.json({
            allowed: true,
            participantIds: access.participantIds,
        });
    } catch (error) {
        if (error instanceof AuthorizationError) {
            return deny("forbidden", 403);
        }

        console.error("authorize-conversation-access error", error);
        return deny("authorization_service_error", 500);
    }
}
