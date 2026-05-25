import mongoose, { Model, Schema } from "mongoose";

export type TaskPlanStatus = "draft" | "approved" | "active" | "completed" | "failed" | "cancelled";

export type TaskStepState =
    | "ready"
    | "running"
    | "waiting_for_dependency"
    | "waiting_for_approval"
    | "retry_scheduled"
    | "blocked"
    | "completed"
    | "failed"
    | "skipped";

export interface ITaskStep {
    stepId: string;
    title: string;
    description: string;
    kind: "tool_call" | "decision" | "approval" | "notification" | "validation";
    order: number;
    dependencies: string[];
    fallbackPolicy: "dependency_preserving" | "immediate_execution";
    overrideDependencies: boolean;
    fallback: Array<{
        stepId: string;
        reason: string;
    }>;
    successCriteria: string[];
    toolCandidates: Array<{
        toolName: string;
        confidence: number;
        riskLevel: "low" | "medium" | "high";
    }>;
    selectedToolName?: string | null;
    input?: Record<string, unknown>;
    output?: Record<string, unknown>;
    state: TaskStepState;
    attempts: number;
    maxAttempts: number;
    lastError?: string | null;
    startedAt?: Date | null;
    completedAt?: Date | null;
}

export interface ITaskPlan {
    _id: mongoose.Types.ObjectId;
    taskId: mongoose.Types.ObjectId;
    conversationId: mongoose.Types.ObjectId;
    goal: string;
    successDefinition: string;
    plannerModel: string;
    plannerVersion: string;
    status: TaskPlanStatus;
    steps: ITaskStep[];
    activeStepId?: string | null;
    planNotes?: string | null;
    createdAt: Date;
    updatedAt: Date;
}

const TaskStepSchema = new Schema<ITaskStep>(
    {
        stepId: { type: String, required: true, trim: true, maxlength: 80 },
        title: { type: String, required: true, trim: true, maxlength: 200 },
        description: { type: String, required: true, trim: true, maxlength: 4000 },
        kind: {
            type: String,
            enum: ["tool_call", "decision", "approval", "notification", "validation"],
            required: true,
            default: "tool_call",
        },
        order: { type: Number, required: true, min: 0 },
        dependencies: { type: [String], default: [] },
        fallbackPolicy: {
            type: String,
            enum: ["dependency_preserving", "immediate_execution"],
            required: true,
            default: "dependency_preserving",
        },
        overrideDependencies: { type: Boolean, required: true, default: false },
        fallback: {
            type: [{
                stepId: { type: String, required: true, trim: true, maxlength: 80 },
                reason: { type: String, required: true, trim: true, maxlength: 500 },
            }],
            default: [],
        },
        successCriteria: { type: [String], default: [] },
        toolCandidates: {
            type: [{
                toolName: { type: String, required: true, trim: true, maxlength: 120 },
                confidence: { type: Number, required: true, min: 0, max: 1 },
                riskLevel: { type: String, enum: ["low", "medium", "high"], required: true },
            }],
            default: [],
        },
        selectedToolName: { type: String, trim: true, maxlength: 120, default: null },
        input: { type: Schema.Types.Mixed, default: null },
        output: { type: Schema.Types.Mixed, default: null },
        state: {
            type: String,
            enum: [
                "ready",
                "running",
                "waiting_for_dependency",
                "waiting_for_approval",
                "retry_scheduled",
                "blocked",
                "completed",
                "failed",
                "skipped",
            ],
            required: true,
            default: "ready",
        },
        attempts: { type: Number, min: 0, default: 0 },
        maxAttempts: { type: Number, min: 1, default: 3 },
        lastError: { type: String, trim: true, maxlength: 4000, default: null },
        startedAt: { type: Date, default: null },
        completedAt: { type: Date, default: null },
    },
    { _id: false }
);

const TaskPlanSchema = new Schema<ITaskPlan>(
    {
        taskId: { type: Schema.Types.ObjectId, ref: "Task", required: true, index: true },
        conversationId: { type: Schema.Types.ObjectId, ref: "Conversation", required: true, index: true },
        goal: { type: String, required: true, trim: true, maxlength: 2000 },
        successDefinition: { type: String, required: true, trim: true, maxlength: 2000 },
        plannerModel: { type: String, required: true, trim: true, maxlength: 120 },
        plannerVersion: { type: String, required: true, trim: true, maxlength: 80 },
        status: {
            type: String,
            enum: ["draft", "approved", "active", "completed", "failed", "cancelled"],
            required: true,
            default: "draft",
            index: true,
        },
        steps: { type: [TaskStepSchema], default: [] },
        activeStepId: { type: String, trim: true, maxlength: 80, default: null },
        planNotes: { type: String, trim: true, maxlength: 4000, default: null },
    },
    {
        timestamps: true,
        versionKey: false,
    }
);

TaskPlanSchema.index({ taskId: 1, createdAt: -1 });
TaskPlanSchema.index({ conversationId: 1, status: 1, updatedAt: -1 });
TaskPlanSchema.index({ "steps.stepId": 1 });

const TaskPlanModel: Model<ITaskPlan> =
    (mongoose.models.TaskPlan as Model<ITaskPlan>) || mongoose.model<ITaskPlan>("TaskPlan", TaskPlanSchema);

export default TaskPlanModel;
