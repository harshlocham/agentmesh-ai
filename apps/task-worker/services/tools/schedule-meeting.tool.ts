import type { Tool, ToolResult } from "./tool-registry.js";
import { z } from "zod";

export class ScheduleMeetingTool implements Tool {
    name = "schedule_meeting";
    description = "Schedule meetings via an external webhook adapter.";
    inputSchema = z.object({
        summary: z.string().min(1).max(200).optional(),
        notes: z.string().min(1).optional(),
        whenText: z.string().min(1).optional(),
        attendeesText: z.string().min(1).optional(),
        participants: z.array(z.string()).optional(),
        attendees: z.array(z.string()).optional(),
    }).passthrough() as unknown as z.ZodType<Record<string, unknown>>;

    async execute(input: Record<string, unknown>, context: { taskId: string; conversationId: string; messageId: string | null; signal?: AbortSignal; metadata?: { idempotencyKey?: string } }): Promise<ToolResult> {
        const webhookUrl = process.env.SCHEDULE_MEETING_WEBHOOK_URL;
        if (!webhookUrl) {
            throw new Error("Schedule meeting adapter is not configured. Set SCHEDULE_MEETING_WEBHOOK_URL.");
        }

        const response = await fetch(webhookUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                ...(context.metadata?.idempotencyKey ? { "Idempotency-Key": context.metadata.idempotencyKey } : {}),
            },
            body: JSON.stringify({
                taskId: context.taskId,
                conversationId: context.conversationId,
                triggerMessageId: context.messageId,
                parameters: input,
            }),
            signal: context.signal,
        });

        const responseText = await response.text();
        let responseBody: unknown = responseText;
        try {
            responseBody = responseText.length > 0 ? JSON.parse(responseText) : null;
        } catch {
            responseBody = responseText;
        }

        return {
            summary: response.ok ? "Scheduled meeting via external adapter." : `Meeting scheduling failed with status ${response.status}.`,
            adapterSuccess: response.ok,
            evidence: {
                responseStatus: response.status,
                responseBody,
            },
            ...(response.ok ? {} : { error: typeof responseBody === "string" ? responseBody.slice(0, 500) : undefined }),
        };
    }
}

export default ScheduleMeetingTool;