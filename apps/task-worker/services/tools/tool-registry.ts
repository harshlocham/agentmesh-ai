import { z } from "zod";

export type ToolExecutionTask = {
    taskId: string;
    conversationId: string;
    toolName: string;
    parameters: Record<string, unknown>;
    messageId: string | null;
};

export type ToolExecutionContext = {
    taskId: string;
    conversationId: string;
    messageId: string | null;
    signal?: AbortSignal;
    metadata?: {
        runId?: string;
        stepId?: string;
        attempt?: number;
        idempotencyKey?: string;
    };
};

export type ToolResult = {
    summary: string;
    adapterSuccess: boolean;
    evidence: unknown;
    error?: string;
};

export interface Tool {
    name: string;
    description: string;
    inputSchema: z.ZodType<Record<string, unknown>>;
    execute(input: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult>;
}

export class ToolRegistry {
    private readonly toolsByName = new Map<string, Tool>();

    register(tool: Tool) {
        this.toolsByName.set(tool.name, tool);
    }

    get(toolName: string): Tool | undefined {
        return this.toolsByName.get(toolName);
    }

    listForLLM() {
        return [...this.toolsByName.values()].map((tool) => ({
            name: tool.name,
            description: tool.description,
            // Expose a JSON-serializable schema representation for LLM routing prompts.
            inputSchema: (tool.inputSchema as unknown as { _def?: unknown })._def ?? null,
        }));
    }

    listOpenAITools() {
        return [...this.toolsByName.values()].map((tool) => ({
            type: "function" as const,
            function: {
                name: tool.name,
                description: tool.description,
                // We intentionally keep parameters permissive because zod internals
                // are not guaranteed to map 1:1 to JSON schema without an adapter.
                parameters: {
                    type: "object",
                    additionalProperties: true,
                },
            },
        }));
    }
}

export default ToolRegistry;