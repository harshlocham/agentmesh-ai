import * as contactService from "@chat/services/contact.service";
import {
    applyClarificationSelection,
    buildAmbiguousContactQuestion,
    type PendingResolution,
} from "./entity-resolution.service.js";

type ResolveToolParametersInput = {
    toolName: string;
    params: Record<string, unknown>;
    userId?: string | null;
    clarificationReply?: string | null;
    pendingResolution?: PendingResolution | null;
};

export type ResolveToolParametersResult =
    | {
        status: "resolved";
        params: Record<string, unknown>;
    }
    | {
        status: "clarification_required";
        clarificationQuestion: string;
        pendingResolution: PendingResolution;
    }
    | {
        status: "failed";
        error: string;
    };

function isValidEmail(value: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

// RFC 2606 reserved + commonly-used placeholder domains the LLM hallucinates
// when it doesn't actually know a recipient. Hitting any of these means we
// must stop and ask the user for the real address instead of trusting the
// fabricated one.
const PLACEHOLDER_EMAIL_DOMAINS = new Set<string>([
    "example.com",
    "example.org",
    "example.net",
    "example.edu",
    "test.com",
    "test.org",
    "test.net",
    "foo.com",
    "bar.com",
    "domain.com",
    "email.com",
    "mail.com",
    "company.com",
    "mycompany.com",
    "yourcompany.com",
    "yourdomain.com",
    "yourname.com",
    "placeholder.com",
    "anywhere.com",
]);

const PLACEHOLDER_RESERVED_TLDS = /\.(test|example|invalid|localhost|local)$/i;

function getEmailDomain(value: string): string | null {
    const at = value.lastIndexOf("@");
    if (at < 0 || at >= value.length - 1) {
        return null;
    }
    return value.slice(at + 1).trim().toLowerCase();
}

function isPlaceholderEmail(value: string): boolean {
    if (!isValidEmail(value)) {
        return false;
    }
    const domain = getEmailDomain(value);
    if (!domain) {
        return false;
    }
    if (PLACEHOLDER_EMAIL_DOMAINS.has(domain)) {
        return true;
    }
    if (PLACEHOLDER_RESERVED_TLDS.test(domain)) {
        return true;
    }
    return false;
}

function buildPlaceholderClarificationResult(
    reference: string,
    params: Record<string, unknown>
): ResolveToolParametersResult {
    const localPart = reference.slice(0, reference.indexOf("@")).trim() || reference;
    const displayName = localPart || reference;
    return {
        status: "clarification_required",
        clarificationQuestion: `I don't have a real email address on file for '${displayName}'. The address I have ('${reference}') looks like a placeholder. What is the actual email address I should send this to?`,
        pendingResolution: {
            toolName: "send_email",
            parametersSnapshot: { ...params },
            ambiguities: [
                {
                    reference,
                    options: [],
                },
            ],
        },
    };
}

function toStringArray(value: unknown): string[] {
    if (typeof value === "string") {
        return value
            .split(/[;,]/)
            .map((item) => item.trim())
            .filter(Boolean);
    }

    if (Array.isArray(value)) {
        return value
            .filter((item) => typeof item === "string")
            .map((item) => item.trim())
            .filter(Boolean);
    }

    return [];
}

function getRecipientReferences(params: Record<string, unknown>): string[] {
    // Accept multiple parameter names like the tool normalizer does
    const candidates = [
        toStringArray(params.to),
        toStringArray(params.recipient),
        toStringArray(params.recipients),
        toStringArray(params.email),
    ];

    for (const candidate of candidates) {
        if (candidate.length > 0) {
            return candidate;
        }
    }

    return [];
}

function dedupeEmails(emails: string[]): string[] {
    const seen = new Set<string>();
    const output: string[] = [];

    for (const email of emails) {
        const normalized = email.trim().toLowerCase();
        if (!normalized || seen.has(normalized)) {
            continue;
        }

        seen.add(normalized);
        output.push(normalized);
    }

    return output;
}

function applyClarificationToSnapshot(
    pending: PendingResolution,
    selectedEmail: string
): Record<string, unknown> {
    const snapshot = { ...pending.parametersSnapshot };
    const references = getRecipientReferences(snapshot);
    const targetReference = pending.ambiguities[0]?.reference?.toLowerCase();

    const replacedRecipients = references.map((recipient) => {
        if (!targetReference) return recipient;
        return recipient.toLowerCase() === targetReference ? selectedEmail : recipient;
    });

    snapshot.to = replacedRecipients;
    return snapshot;
}

async function resolveSendEmailParams(
    params: Record<string, unknown>,
    userId?: string | null
): Promise<ResolveToolParametersResult> {
    const references = getRecipientReferences(params);

    if (references.length === 0) {
        return {
            status: "failed",
            error: "send_email requires at least one recipient in 'to'.",
        };
    }

    const resolvedEmails: string[] = [];

    for (const reference of references) {
        // Reject obvious LLM-hallucinated emails (RFC 2606 reserved + common
        // placeholder domains) BEFORE any contact lookup. The contact resolver
        // currently trusts any syntactically valid email, so if we don't catch
        // these here the agent will silently send to a fake address.
        if (isPlaceholderEmail(reference)) {
            return buildPlaceholderClarificationResult(reference, params);
        }

        if (!userId) {
            if (isValidEmail(reference)) {
                resolvedEmails.push(reference.trim().toLowerCase());
                continue;
            }

            return {
                status: "failed",
                error: `Missing user context for resolving recipient '${reference}'.`,
            };
        }

        const resolved = await contactService.resolveContactReference(userId, reference);
        if (resolved.success && resolved.resolved) {
            resolvedEmails.push(resolved.resolved.email);
            continue;
        }

        if (isValidEmail(reference)) {
            resolvedEmails.push(reference.trim().toLowerCase());
            continue;
        }

        if (Array.isArray(resolved.ambiguous) && resolved.ambiguous.length > 0) {
            return {
                status: "clarification_required",
                clarificationQuestion: buildAmbiguousContactQuestion(reference, resolved.ambiguous),
                pendingResolution: {
                    toolName: "send_email",
                    parametersSnapshot: { ...params },
                    ambiguities: [
                        {
                            reference,
                            options: resolved.ambiguous,
                        },
                    ],
                },
            };
        }

        return {
            status: "failed",
            error: resolved.error ?? `Unable to resolve recipient '${reference}'.`,
        };
    }

    return {
        status: "resolved",
        params: {
            ...params,
            to: dedupeEmails(resolvedEmails),
        },
    };
}

export async function resolveToolParameters(input: ResolveToolParametersInput): Promise<ResolveToolParametersResult> {
    if (input.toolName !== "send_email") {
        return {
            status: "resolved",
            params: { ...input.params },
        };
    }

    const hasPending = input.pendingResolution
        && input.pendingResolution.toolName === "send_email"
        && Array.isArray(input.pendingResolution.ambiguities)
        && input.pendingResolution.ambiguities.length > 0;

    if (hasPending && input.clarificationReply) {
        const selection = applyClarificationSelection(input.pendingResolution as PendingResolution, input.clarificationReply);
        if (!selection.success) {
            return {
                status: "clarification_required",
                clarificationQuestion: `I could not understand your selection. ${selection.error}`,
                pendingResolution: input.pendingResolution as PendingResolution,
            };
        }

        const updatedParams = applyClarificationToSnapshot(input.pendingResolution as PendingResolution, selection.selectedEmail);
        return resolveSendEmailParams(updatedParams, input.userId);
    }

    return resolveSendEmailParams(input.params, input.userId);
}
