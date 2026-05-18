import { NextRequest, NextResponse } from "next/server";
import { createMessage } from "@/lib/services/message.service";
import { CreateMessageSchema } from "@/lib/validators/message.schema";
import { getPaginatedMessages } from "@/lib/repositories/message.repo";
import { normalizeMessage } from "@/server/normalizers/message.normalizer";
import { requireAuthUser } from "@/lib/utils/auth/requireAuthUser";
import { requireConversationAccess } from "@/lib/utils/auth/requireConversationAccess";
import { AuthorizationError } from "@chat/services/authorization.service";

export async function POST(req: NextRequest) {
    try {
        const guard = await requireAuthUser();
        if (guard.response) {
            return guard.response;
        }
        const senderId = guard.user.id;
        const requestBody = await req.json();
        const parsed = CreateMessageSchema.parse(requestBody);

        const access = await requireConversationAccess(parsed.conversationId, guard.user);
        if (access.response) return access.response;

        const message = await createMessage(parsed, senderId);
        const clientMessage = normalizeMessage(message);

        return NextResponse.json(clientMessage, { status: 201 });
    } catch (error) {
        if (error instanceof AuthorizationError) {
            return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }

        console.error("❌ Message POST error:", error);

        return NextResponse.json(
            { error: error || "Invalid input" },
            { status: 400 }
        );
    }
}

export async function GET(req: NextRequest) {
    try {
        const guard = await requireAuthUser();
        if (guard.response) {
            return guard.response;
        }

        const { searchParams } = new URL(req.url);
        const conversationId = searchParams.get("conversationId");
        if (!conversationId) {
            return NextResponse.json({ error: "conversationId is required" }, { status: 400 });
        }

        const access = await requireConversationAccess(conversationId, guard.user);
        if (access.response) return access.response;

        const cursor = searchParams.get("cursor") || undefined;

        const messages = await getPaginatedMessages(conversationId, cursor);
        const clientMessages = (Array.isArray(messages) ? messages : []).map(normalizeMessage);
        return NextResponse.json(clientMessages, { status: 200 });
    } catch (err) {
        console.error(err);
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
}
