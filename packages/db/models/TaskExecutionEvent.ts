import mongoose, { Model, Schema } from "mongoose";

export type TaskExecutionEventType =
    | "execution_started"
    | "phase_transition"
    | "tool_selected"
    | "tool_started"
    | "tool_completed"
    | "tool_failed"
    | "retry_scheduled"
    | "retry_started"
    | "waiting_for_approval"
    | "waiting_for_input"
    | "verification"
    | "execution_completed"
    | "execution_failed";

export type TaskExecutionEventPhase =
    | "intake"
    | "policy"
    | "reason"
    | "tool_execute"
    | "observe"
    | "verify"
    | "finalize"
    | "retry";

export interface ITaskExecutionEvent {
    _id: mongoose.Types.ObjectId;
    taskId: mongoose.Types.ObjectId;
    conversationId: mongoose.Types.ObjectId;
    runId: string;
    sequence: number;
    type: TaskExecutionEventType;
    phase: TaskExecutionEventPhase;
    payload: Record<string, unknown>;
    createdAt: Date;
}

const TaskExecutionEventSchema = new Schema<ITaskExecutionEvent>(
    {
        taskId: { type: Schema.Types.ObjectId, ref: "Task", required: true, index: true },
        conversationId: { type: Schema.Types.ObjectId, ref: "Conversation", required: true, index: true },
        runId: { type: String, required: true, trim: true, maxlength: 80, index: true },
        sequence: { type: Number, required: true, min: 1 },
        type: {
            type: String,
            enum: [
                "execution_started",
                "phase_transition",
                "tool_selected",
                "tool_started",
                "tool_completed",
                "tool_failed",
                "retry_scheduled",
                "retry_started",
                "waiting_for_approval",
                "waiting_for_input",
                "verification",
                "execution_completed",
                "execution_failed",
            ],
            required: true,
            index: true,
        },
        phase: {
            type: String,
            enum: ["intake", "policy", "reason", "tool_execute", "observe", "verify", "finalize", "retry"],
            required: true,
        },
        payload: { type: Schema.Types.Mixed, default: {} },
        createdAt: { type: Date, default: Date.now, index: true },
    },
    { timestamps: false, strict: true }
);

TaskExecutionEventSchema.index({ taskId: 1, sequence: 1 });
TaskExecutionEventSchema.index({ taskId: 1, runId: 1, sequence: 1 }, { unique: true });

const TaskExecutionEventModel: Model<ITaskExecutionEvent> =
    (mongoose.models.TaskExecutionEvent as Model<ITaskExecutionEvent>)
    || mongoose.model<ITaskExecutionEvent>("TaskExecutionEvent", TaskExecutionEventSchema);

export default TaskExecutionEventModel;
