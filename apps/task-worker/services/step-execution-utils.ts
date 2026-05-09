import { z } from "zod";
import { normalizeToolParams } from "@chat/services/tool-normalizers.js";

const TEMPLATE_PATTERN = /{{\s*([^}]+)\s*}}/g;
const EMAIL_PLACEHOLDER_PATTERN = /\[[^\]]+\]/;

export const llmDecisionSchema = z.object({
    tool: z.string().nullable(),
    confidence: z.number(),
    parameters: z.record(z.string(), z.unknown()),
    reasoning: z.string().optional(),
    noAction: z.boolean().optional(),
    needsClarification: z.boolean().optional(),
    clarificationQuestion: z.string().nullable().optional(),
});

export type LlmDecision = z.infer<typeof llmDecisionSchema>;

export type StepOutputRecord = {
    summary: string;
    data: unknown;
};

export type PreviousStepOutputs = Record<string, StepOutputRecord>;

type ToolLike = {
    name: string;
    inputSchema: z.ZodType<Record<string, unknown>>;
};

function getPathValue(input: unknown, path: string[]): unknown {
    let current: unknown = input;
    for (const key of path) {
        if (current == null || typeof current !== "object") {
            return undefined;
        }
        current = (current as Record<string, unknown>)[key];
    }
    return current;
}

function replaceTemplateString(input: string, previousOutputs: PreviousStepOutputs): string {
    return input.replace(TEMPLATE_PATTERN, (match, expression: string) => {
        const segments = expression.split(".").map((segment) => segment.trim()).filter(Boolean);
        if (segments.length === 0) {
            return match;
        }

        const [stepId, ...path] = segments;
        const stepOutput = previousOutputs[stepId];
        if (!stepOutput) {
            return match;
        }

        if (path.length === 0) {
            if (typeof stepOutput.data === "string") {
                return stepOutput.data;
            }
            return JSON.stringify(stepOutput.data);
        }

        const resolved = getPathValue({ summary: stepOutput.summary, data: stepOutput.data }, path);
        if (resolved === undefined || resolved === null) {
            return match;
        }

        if (typeof resolved === "string") {
            return resolved;
        }

        if (typeof resolved === "number" || typeof resolved === "boolean") {
            return String(resolved);
        }

        return JSON.stringify(resolved);
    });
}

export function resolveStepTemplates(input: unknown, previousOutputs: PreviousStepOutputs): unknown {
    if (typeof input === "string") {
        return replaceTemplateString(input, previousOutputs);
    }

    if (Array.isArray(input)) {
        return input.map((value) => resolveStepTemplates(value, previousOutputs));
    }

    if (input && typeof input === "object") {
        return Object.fromEntries(
            Object.entries(input as Record<string, unknown>).map(([key, value]) => [key, resolveStepTemplates(value, previousOutputs)])
        );
    }

    return input;
}

export function collectPreviousStepOutputs(steps: Array<{ stepId: string; state: string; output?: Record<string, unknown> | null }>): PreviousStepOutputs {
    const outputs: PreviousStepOutputs = {};

    for (const step of steps) {
        if (step.state !== "completed" || !step.output) {
            continue;
        }

        const summary = typeof step.output.summary === "string" ? step.output.summary : "";
        const data = Object.prototype.hasOwnProperty.call(step.output, "data") ? step.output.data : step.output;
        outputs[step.stepId] = { summary, data };
    }

    return outputs;
}

export function normalizeParams(toolName: string, params: Record<string, unknown>): Record<string, unknown> {
    if (toolName === "send_email") {
        try {
            return normalizeToolParams(toolName, params);
        } catch (error) {
            console.warn("Tool parameter normalization failed", {
                error,
                toolName,
                params,
            });
            return { ...params };
        }
    }

    const normalized = { ...params };

    if (toolName === "schedule_meeting") {
        if (normalized.attendee !== undefined && normalized.attendees === undefined) {
            normalized.attendees = normalized.attendee;
            delete normalized.attendee;
        }

        if (typeof normalized.attendees === "string") {
            normalized.attendees = [normalized.attendees];
        }

        if (Array.isArray(normalized.attendees)) {
            normalized.attendees = normalized.attendees.filter((entry) => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean);
        }
    }

    return normalized;
}

export function hasInvalidPlaceholderValue(value: unknown): boolean {
    if (typeof value === "string") {
        return EMAIL_PLACEHOLDER_PATTERN.test(value) || value.includes("{{") || value.includes("}}");
    }

    if (Array.isArray(value)) {
        return value.some((entry) => hasInvalidPlaceholderValue(entry));
    }

    if (value && typeof value === "object") {
        return Object.values(value as Record<string, unknown>).some((entry) => hasInvalidPlaceholderValue(entry));
    }

    return false;
}

export function validateToolParameters(tool: ToolLike, params: Record<string, unknown>): string | null {
    if (hasInvalidPlaceholderValue(params)) {
        return `Tool ${tool.name} parameters contain unresolved placeholders.`;
    }

    if (tool.name === "send_email") {
        const to = params.to;
        const recipients = Array.isArray(to) ? to : typeof to === "string" ? [to] : [];
        if (recipients.length === 0) {
            return "send_email requires at least one recipient.";
        }

        for (const recipient of recipients) {
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
                return `Invalid email address: ${recipient}`;
            }
        }
    }

    if (tool.name === "schedule_meeting") {
        const summary = params.summary;
        const whenText = params.whenText;
        if (typeof summary !== "string" || summary.trim().length === 0) {
            return "schedule_meeting requires summary.";
        }
        if (typeof whenText !== "string" || whenText.trim().length === 0) {
            return "schedule_meeting requires whenText.";
        }
    }

    if (tool.name === "create_github_issue") {
        if (typeof params.title !== "string" || params.title.trim().length === 0) {
            return "create_github_issue requires title.";
        }
    }

    return null;
}
