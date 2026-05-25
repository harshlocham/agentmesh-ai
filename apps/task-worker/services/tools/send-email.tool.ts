import type { Tool, ToolResult } from "./tool-registry.js";
import { z } from "zod";

export class SendEmailTool implements Tool {
    name = "send_email";
    description = "Send transactional emails using the Resend API.";
    inputSchema = z.object({
        to: z.union([z.array(z.string().email()).min(1), z.string().email()]),
        subject: z.string().min(1).max(200).optional(),
        body: z.string().min(1).optional(),
    }) as unknown as z.ZodType<Record<string, unknown>>;

    async execute(input: Record<string, unknown>, context: { taskId: string; signal?: AbortSignal; metadata?: { idempotencyKey?: string } }): Promise<ToolResult> {
        const apiKey = process.env.RESEND_API_KEY;
        const from = process.env.RESEND_FROM_EMAIL;

        if (!apiKey || !from) {
            throw new Error("Email adapter is not configured. Set RESEND_API_KEY and RESEND_FROM_EMAIL.");
        }

        const toValue = input.to;
        const to = Array.isArray(toValue)
            ? toValue
            : typeof toValue === "string"
                ? [toValue]
                : [];

        if (to.length === 0) {
            throw new Error("Email adapter requires parameters.to");
        }

        const subject = typeof input.subject === "string"
            ? input.subject
            : `Task update ${context.taskId}`;

        const body = typeof input.body === "string"
            ? input.body
            : `Automated update for task ${context.taskId}.`;

        const response = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
                Authorization: `Bearer ${apiKey}`,
                "Content-Type": "application/json",
                ...(context.metadata?.idempotencyKey ? { "Idempotency-Key": context.metadata.idempotencyKey } : {}),
            },
            body: JSON.stringify({
                from,
                to,
                subject,
                text: body,
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
            summary: response.ok ? `Sent email to ${to.join(", ")}.` : `Email sending failed with status ${response.status}.`,
            adapterSuccess: response.ok,
            evidence: {
                responseStatus: response.status,
                responseBody,
                to,
            },
            ...(response.ok ? {} : { error: typeof responseBody === "string" ? responseBody.slice(0, 500) : undefined }),
        };
    }
}

export default SendEmailTool;