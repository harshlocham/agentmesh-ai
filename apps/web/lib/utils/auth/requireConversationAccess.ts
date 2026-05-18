import { NextResponse } from "next/server";
import {
    assertConversationAccess,
    assertTaskAccess,
    AuthorizationError,
    type ConversationAccessOptions,
} from "@chat/services/authorization.service";
import type { AuthUser } from "@/lib/utils/auth/getAuthUser";

type AccessGuardResult =
    | { response: null }
    | { response: NextResponse };

function forbiddenResponse() {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
}

function notFoundResponse(resource: "Task" | "Conversation" = "Conversation") {
    return NextResponse.json({ error: `${resource} not found` }, { status: 404 });
}

function accessOptionsForUser(user: AuthUser): ConversationAccessOptions {
    return {
        userRole: user.role,
        allowAdminBypass: true,
    };
}

export async function requireConversationAccess(
    conversationId: string,
    user: AuthUser
): Promise<AccessGuardResult> {
    try {
        await assertConversationAccess(user.id, conversationId, accessOptionsForUser(user));
        return { response: null };
    } catch (error) {
        if (error instanceof AuthorizationError) {
            if (error.code === "NOT_FOUND") {
                return { response: notFoundResponse("Conversation") };
            }

            return { response: forbiddenResponse() };
        }

        throw error;
    }
}

export async function requireTaskAccess(
    taskId: string,
    user: AuthUser
): Promise<AccessGuardResult & { conversationId?: string }> {
    try {
        const access = await assertTaskAccess(user.id, taskId, accessOptionsForUser(user));
        return { response: null, conversationId: access.conversationId };
    } catch (error) {
        if (error instanceof AuthorizationError) {
            if (error.code === "NOT_FOUND") {
                return { response: notFoundResponse("Task") };
            }

            return { response: forbiddenResponse() };
        }

        throw error;
    }
}
