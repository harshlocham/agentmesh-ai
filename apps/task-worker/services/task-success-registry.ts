import type { TaskExecutionActionType, TaskValidationLog } from "@chat/types";

type TaskLike = {
    _id: { toString(): string };
    title: string;
};

type ActionExecutionResultLike = {
    summary: string;
    adapterSuccess: boolean;
    evidence: unknown;
    error?: string;
};

function asRecord(value: unknown): Record<string, unknown> {
    if (value && typeof value === "object") {
        return value as Record<string, unknown>;
    }
    return {};
}

function hasNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0;
}

export interface TaskSuccessValidator {
    actionType: TaskExecutionActionType;
    successCriteria(task: TaskLike, result: ActionExecutionResultLike): boolean;
    validate(task: TaskLike, result: ActionExecutionResultLike): TaskValidationLog;
}

export class TaskSuccessRegistry {
    private readonly validators = new Map<TaskExecutionActionType, TaskSuccessValidator>();

    register(validator: TaskSuccessValidator) {
        this.validators.set(validator.actionType, validator);
    }

    validate(actionType: TaskExecutionActionType, task: TaskLike, result: ActionExecutionResultLike): TaskValidationLog {
        const validator = this.validators.get(actionType);
        if (!validator) {
            const success = result.adapterSuccess;
            return {
                validator: "default-adapter-success",
                passed: success,
                checks: [
                    {
                        name: "adapterSuccess",
                        passed: success,
                        details: success ? "Adapter returned success." : (result.error ?? "Adapter returned failure."),
                    },
                ],
                evaluatedAt: new Date().toISOString(),
            };
        }

        return validator.validate(task, result);
    }
}

class EmailSuccessValidator implements TaskSuccessValidator {
    actionType: TaskExecutionActionType = "send_email";

    successCriteria(task: TaskLike, result: ActionExecutionResultLike): boolean {
        const log = this.validate(task, result);
        return log.passed;
    }

    validate(_task: TaskLike, result: ActionExecutionResultLike): TaskValidationLog {
        const evidence = asRecord(result.evidence);
        const adapterEvidence = asRecord(evidence.result);
        const responseBody = asRecord(adapterEvidence.responseBody);
        const messageId = hasNonEmptyString(responseBody.id)
            ? responseBody.id
            : hasNonEmptyString(responseBody.messageId)
                ? responseBody.messageId
                : "";

        const bounceDetected = responseBody.bounced === true
            || responseBody.bounce === true
            || hasNonEmptyString(responseBody.bounceReason)
            || (hasNonEmptyString(responseBody.status) && responseBody.status.toLowerCase() === "bounced");

        const checks: TaskValidationLog["checks"] = [
            {
                name: "messageIdExists",
                passed: messageId.length > 0,
                details: messageId.length > 0 ? `messageId=${messageId}` : "No message id in provider response.",
            },
            {
                name: "noBounce",
                passed: !bounceDetected,
                details: bounceDetected ? "Bounce marker detected in provider response." : "No bounce marker detected.",
            },
        ];

        return {
            validator: "email-success-v1",
            passed: this.successCriteriaFromChecks(checks),
            checks,
            evaluatedAt: new Date().toISOString(),
        };
    }

    private successCriteriaFromChecks(checks: TaskValidationLog["checks"]) {
        return checks.every((check) => check.passed);
    }
}

class MeetingSuccessValidator implements TaskSuccessValidator {
    actionType: TaskExecutionActionType = "schedule_meeting";

    successCriteria(task: TaskLike, result: ActionExecutionResultLike): boolean {
        const log = this.validate(task, result);
        return log.passed;
    }

    validate(_task: TaskLike, result: ActionExecutionResultLike): TaskValidationLog {
        const evidence = asRecord(result.evidence);
        const adapterEvidence = asRecord(evidence.result);
        const responseBody = asRecord(adapterEvidence.responseBody);

        const eventId = hasNonEmptyString(responseBody.eventId)
            ? responseBody.eventId
            : hasNonEmptyString(responseBody.meetingId)
                ? responseBody.meetingId
                : hasNonEmptyString(responseBody.id)
                    ? responseBody.id
                    : "";

        const participants = Array.isArray(responseBody.participants)
            ? responseBody.participants
            : Array.isArray(responseBody.attendees)
                ? responseBody.attendees
                : [];

        const participantsAdded = responseBody.participantsAdded === true
            || (typeof responseBody.participantsAddedCount === "number" && responseBody.participantsAddedCount > 0)
            || participants.length > 0;

        const checks: TaskValidationLog["checks"] = [
            {
                name: "eventIdExists",
                passed: eventId.length > 0,
                details: eventId.length > 0 ? `eventId=${eventId}` : "No event id in scheduling response.",
            },
            {
                name: "participantsAdded",
                passed: participantsAdded,
                details: participantsAdded
                    ? `participants=${participants.length}`
                    : "No participants marker in scheduling response.",
            },
        ];

        return {
            validator: "meeting-success-v1",
            passed: this.successCriteriaFromChecks(checks),
            checks,
            evaluatedAt: new Date().toISOString(),
        };
    }

    private successCriteriaFromChecks(checks: TaskValidationLog["checks"]) {
        return checks.every((check) => check.passed);
    }
}

class GithubIssueSuccessValidator implements TaskSuccessValidator {
    actionType: TaskExecutionActionType = "create_github_issue";

    successCriteria(task: TaskLike, result: ActionExecutionResultLike): boolean {
        const log = this.validate(task, result);
        return log.passed;
    }

    validate(_task: TaskLike, result: ActionExecutionResultLike): TaskValidationLog {
        const evidence = asRecord(result.evidence);
        const adapterEvidence = asRecord(evidence.result);
        const issue = asRecord(adapterEvidence.issue);
        const issueUrl = hasNonEmptyString(issue.html_url)
            ? issue.html_url
            : hasNonEmptyString(adapterEvidence.issueUrl)
                ? adapterEvidence.issueUrl
                : "";

        const checks: TaskValidationLog["checks"] = [
            {
                name: "issueUrlExists",
                passed: issueUrl.length > 0,
                details: issueUrl.length > 0 ? issueUrl : "No issue URL in GitHub response.",
            },
        ];

        return {
            validator: "github-issue-success-v1",
            passed: this.successCriteriaFromChecks(checks),
            checks,
            evaluatedAt: new Date().toISOString(),
        };
    }

    private successCriteriaFromChecks(checks: TaskValidationLog["checks"]) {
        return checks.every((check) => check.passed);
    }
}

export function createDefaultTaskSuccessRegistry() {
    const registry = new TaskSuccessRegistry();
    registry.register(new EmailSuccessValidator());
    registry.register(new MeetingSuccessValidator());
    registry.register(new GithubIssueSuccessValidator());
    return registry;
}

export default TaskSuccessRegistry;
