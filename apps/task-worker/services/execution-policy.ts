import type { TaskExecutionActionType } from "@chat/types";

type RequestedPayload = {
    actionType: TaskExecutionActionType;
    parameters?: Record<string, unknown>;
    confidence?: number;
    needsApproval?: boolean;
};

export type ExecutionPolicyOutcome = "auto_execute" | "approval_required" | "blocked";

export type ExecutionRiskLevel = "low" | "medium" | "high";

export type ExecutionPolicyDecision = {
    outcome: ExecutionPolicyOutcome;
    riskLevel: ExecutionRiskLevel;
    reasons: string[];
};

function toStringArray(value: unknown): string[] {
    if (Array.isArray(value)) {
        return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
    }

    if (typeof value === "string" && value.trim().length > 0) {
        return [value.trim()];
    }

    return [];
}

function emailDomain(email: string): string {
    const at = email.lastIndexOf("@");
    if (at < 0 || at === email.length - 1) return "";
    return email.slice(at + 1).toLowerCase();
}

function getAllowedEmailDomains(): string[] {
    const raw = process.env.TASK_WORKER_ALLOWED_EMAIL_DOMAINS || process.env.ALLOWED_EMAIL_DOMAINS || "";
    return raw
        .split(",")
        .map((entry) => entry.trim().toLowerCase())
        .filter((entry) => entry.length > 0);
}

export function evaluateExecutionPolicy(payload: RequestedPayload): ExecutionPolicyDecision {
    const confidence = typeof payload.confidence === "number" ? payload.confidence : 0.5;
    const reasons: string[] = [];

    if (payload.actionType === "none") {
        return {
            outcome: "auto_execute",
            riskLevel: "low",
            reasons: ["Autonomous mode: agent-runner will decide the next tool."],
        };
    }

    if (payload.needsApproval) {
        reasons.push("Upstream classifier marked action as requiring approval.");
    }

    if (confidence < 0.7) {
        reasons.push(`Low confidence (${confidence.toFixed(2)}).`);
    }

    const parameters = payload.parameters ?? {};

    if (payload.actionType === "send_email") {
        const recipients = toStringArray(parameters.to);
        if (recipients.length === 0) {
            return {
                outcome: "blocked",
                riskLevel: "high",
                reasons: ["Email action has no valid recipients."],
            };
        }

        const allowedDomains = getAllowedEmailDomains();
        if (allowedDomains.length > 0) {
            const externalRecipients = recipients.filter((recipient) => {
                if (!recipient.includes("@")) {
                    return false;
                }
                return !allowedDomains.includes(emailDomain(recipient));
            });
            if (externalRecipients.length > 0) {
                reasons.push("One or more recipients are outside allowed domains.");
            }
        }

        if (recipients.length > 5) {
            reasons.push("Email action has more than 5 recipients.");
        }
    }

    if (payload.actionType === "schedule_meeting") {
        const participants = toStringArray(parameters.participants).concat(toStringArray(parameters.attendees));
        if (participants.length === 0) {
            reasons.push("Meeting action has no explicit participants in parameters.");
        }
    }

    if (payload.actionType === "create_github_issue") {
        const title = typeof parameters.title === "string" ? parameters.title.trim() : "";
        if (title.length === 0) {
            reasons.push("GitHub issue action is missing a title.");
        }
    }

    if (reasons.length === 0) {
        return {
            outcome: "auto_execute",
            riskLevel: "low",
            reasons: ["Policy checks passed for automatic execution."],
        };
    }

    const highRiskReason = reasons.some((reason) =>
        reason.includes("outside allowed domains")
        || reason.includes("no valid recipients")
        || reason.includes("No executable action")
    );

    return {
        outcome: "approval_required",
        riskLevel: highRiskReason ? "high" : "medium",
        reasons,
    };
}

export default evaluateExecutionPolicy;
