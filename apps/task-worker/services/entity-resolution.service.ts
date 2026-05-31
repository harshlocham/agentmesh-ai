export type AmbiguousContactOption = {
    name: string;
    email: string;
};

export type PendingResolution = {
    toolName: "send_email";
    parametersSnapshot: Record<string, unknown>;
    ambiguities: Array<{
        reference: string;
        options: AmbiguousContactOption[];
    }>;
};

export function buildAmbiguousContactQuestion(reference: string, options: AmbiguousContactOption[]): string {
    const lines = options.map((option, index) => `${index + 1}. ${option.name} (${option.email})`);
    return `I found multiple contacts for '${reference}'.\n${lines.join("\n")}\nWhich one should I use? Reply with a number or email.`;
}

const FREE_FORM_EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function applyClarificationSelection(
    pending: PendingResolution,
    clarificationReply: string
): { success: true; selectedEmail: string; selectedName: string } | { success: false; error: string } {
    const ambiguity = pending.ambiguities[0];
    if (!ambiguity) {
        return { success: false, error: "No pending ambiguity was found." };
    }

    const reply = clarificationReply.trim();
    if (!reply) {
        return { success: false, error: "Clarification reply was empty." };
    }

    // When no predefined options exist, the clarification was a free-form
    // "what email should I use?" prompt (e.g. for a placeholder/hallucinated
    // address). Accept any well-formed email the user supplies.
    if (ambiguity.options.length === 0) {
        if (!FREE_FORM_EMAIL_REGEX.test(reply)) {
            return {
                success: false,
                error: "Please reply with a valid email address (for example: jane.doe@gmail.com).",
            };
        }
        return {
            success: true,
            selectedEmail: reply,
            selectedName: ambiguity.reference,
        };
    }

    const selectedIndex = Number.parseInt(reply, 10);
    if (!Number.isNaN(selectedIndex) && selectedIndex >= 1 && selectedIndex <= ambiguity.options.length) {
        const selected = ambiguity.options[selectedIndex - 1];
        return { success: true, selectedEmail: selected.email, selectedName: selected.name };
    }

    const selectedByEmail = ambiguity.options.find((option) => option.email.toLowerCase() === reply.toLowerCase());
    if (selectedByEmail) {
        return { success: true, selectedEmail: selectedByEmail.email, selectedName: selectedByEmail.name };
    }

    const selectedByName = ambiguity.options.find((option) => option.name.toLowerCase() === reply.toLowerCase());
    if (selectedByName) {
        return { success: true, selectedEmail: selectedByName.email, selectedName: selectedByName.name };
    }

    return { success: false, error: "Could not match clarification reply to any candidate." };
}
