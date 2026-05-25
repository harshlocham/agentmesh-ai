import type { TaskExecutionActionType } from "./task.js";

export type ExecutionToolDefinition = {
    name: Exclude<TaskExecutionActionType, "none">;
    description: string;
    inputFields: string[];
};

export const EXECUTION_TOOLS: readonly ExecutionToolDefinition[] = [
    {
        name: "create_github_issue",
        description: "Create a GitHub issue in the configured repository.",
        inputFields: ["title", "body", "labels"],
    },
    {
        name: "schedule_meeting",
        description: "Schedule a meeting using the external calendar webhook adapter.",
        inputFields: ["summary", "notes", "whenText", "attendeesText"],
    },
    {
        name: "send_email",
        description: "Send an email update using the configured email adapter.",
        inputFields: ["to", "subject", "body"],
    },
] as const;

export const EXECUTION_TOOL_NAMES = EXECUTION_TOOLS.map((tool) => tool.name) as ReadonlyArray<Exclude<TaskExecutionActionType, "none">>;
