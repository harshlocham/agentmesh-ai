import mongoose, { Model, Schema } from "mongoose";

export type TaskActionType =
    | "created"
    | "reassigned"
    | "status_changed"
    | "priority_changed"
    | "due_changed"
    | "linked_message"
    | "unlinked_message"
    | "commented"
    | "ai_reclassified"
    | "create_github_issue"
    | "schedule_meeting"
    | "send_email"
    | "none";

export type TaskActorType = "user" | "agent" | "system";
export type TaskActionExecutionState = "requested" | "approval_pending" | "approved" | "rejected" | "queued" | "running" | "succeeded" | "failed" | "blocked" | "expired" | null;

export interface ITaskAction {
    _id: mongoose.Types.ObjectId;
    taskId: mongoose.Types.ObjectId;
    conversationId: mongoose.Types.ObjectId;
    actorType: TaskActorType;
    actorId?: mongoose.Types.ObjectId | null;
    actionType: TaskActionType;
    toolName?: string | null;
    messageId?: mongoose.Types.ObjectId | null;
    parameters?: Record<string, unknown>;
    executionState?: TaskActionExecutionState;
    summary?: string | null;
    error?: string | null;
    patch: {
        before: unknown | null;
        after: unknown | null;
    };
    reason: string;
    idempotencyKey: string;
    createdAt: Date;
}

const TaskActionSchema = new Schema<ITaskAction>(
    {
        taskId: { type: Schema.Types.ObjectId, ref: "Task", required: true, index: true },
        conversationId: { type: Schema.Types.ObjectId, ref: "Conversation", required: true, index: true },
        actorType: { type: String, enum: ["user", "agent", "system"], required: true },
        actorId: { type: Schema.Types.ObjectId, ref: "User", default: null },
        actionType: {
            type: String,
            enum: [
                "created",
                "reassigned",
                "status_changed",
                "priority_changed",
                "due_changed",
                "linked_message",
                "unlinked_message",
                "commented",
                "ai_reclassified",
                "create_github_issue",
                "schedule_meeting",
                "send_email",
                "none"
            ],
            required: true,
            index: true,
        },
        toolName: { type: String, trim: true, maxlength: 120, default: null, index: true },
        messageId: { type: Schema.Types.ObjectId, ref: "Message", default: null, index: true },
        parameters: { type: Schema.Types.Mixed, default: {} },
        executionState: {
            type: String,
            enum: ["requested", "approval_pending", "approved", "rejected", "queued", "running", "succeeded", "failed", "blocked", "expired"],
            default: null,
            index: true,
        },
        summary: { type: String, trim: true, maxlength: 2000, default: null },
        error: { type: String, trim: true, maxlength: 4000, default: null },
        patch: {
            before: { type: Schema.Types.Mixed, default: null },
            after: { type: Schema.Types.Mixed, default: null },
        },
        reason: { type: String, trim: true, maxlength: 2000, default: "" },
        idempotencyKey: { type: String, required: true, maxlength: 160, unique: true },
        createdAt: { type: Date, default: Date.now, index: true },
    },
    { timestamps: false, strict: true }
);

TaskActionSchema.index({ taskId: 1, createdAt: 1 });
TaskActionSchema.index({ conversationId: 1, createdAt: -1 });

const TaskActionModel: Model<ITaskAction> =
    (mongoose.models.TaskAction as Model<ITaskAction>) || mongoose.model<ITaskAction>("TaskAction", TaskActionSchema);

export default TaskActionModel;