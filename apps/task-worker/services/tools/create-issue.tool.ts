import type { Tool, ToolResult } from "./tool-registry.js";
import { z } from "zod";

export class CreateIssueTool implements Tool {
    name = "create_github_issue";
    description = "Create GitHub issues in a configured repository.";
    inputSchema = z.object({
        title: z.string().min(1).max(200).optional(),
        body: z.string().min(1).optional(),
        labels: z.array(z.string()).optional(),
    }).passthrough() as unknown as z.ZodType<Record<string, unknown>>;

    async execute(input: Record<string, unknown>, context: { taskId: string; conversationId: string; signal?: AbortSignal; metadata?: { idempotencyKey?: string } }): Promise<ToolResult> {
        const token = process.env.GITHUB_TOKEN;
        const repo = process.env.GITHUB_REPO;

        if (!token || !repo || !repo.includes("/")) {
            throw new Error("GitHub adapter is not configured. Set GITHUB_TOKEN and GITHUB_REPO=owner/repo.");
        }

        const title = typeof input.title === "string"
            ? input.title
            : `Task: ${context.taskId}`;
        const body = typeof input.body === "string"
            ? input.body
            : `Auto-created from task ${context.taskId} in conversation ${context.conversationId}.`;

        const response = await fetch(`https://api.github.com/repos/${repo}/issues`, {
            method: "POST",
            headers: {
                Accept: "application/vnd.github+json",
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
                "User-Agent": "chat-task-worker",
                ...(context.metadata?.idempotencyKey ? { "Idempotency-Key": context.metadata.idempotencyKey } : {}),
            },
            body: JSON.stringify({ title, body }),
            signal: context.signal,
        });

        const issue = (await response.json()) as { html_url?: string; number?: number; message?: string };

        return {
            summary: response.ok ? `Created GitHub issue #${issue.number ?? "?"}${issue.html_url ? ` (${issue.html_url})` : ""}` : `GitHub issue creation failed with status ${response.status}.`,
            adapterSuccess: response.ok,
            evidence: {
                responseStatus: response.status,
                issue,
            },
            ...(response.ok ? {} : { error: typeof issue.message === "string" ? issue.message : undefined }),
        };
    }
}

export default CreateIssueTool;