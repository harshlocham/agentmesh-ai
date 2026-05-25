import mongoose, { Model, Schema } from "mongoose";

export type ReflectionOutcome = "completed" | "failed" | "partial";

export interface ITaskReflection {
    _id: mongoose.Types.ObjectId;
    taskId: mongoose.Types.ObjectId;
    conversationId: mongoose.Types.ObjectId;
    runId?: mongoose.Types.ObjectId | null;
    outcome: ReflectionOutcome;
    whatWorked: string[];
    whatFailed: string[];
    improvements: string[];
    confidence: number;
    generatedByModel: string;
    createdAt: Date;
}

const TaskReflectionSchema = new Schema<ITaskReflection>(
    {
        taskId: { type: Schema.Types.ObjectId, ref: "Task", required: true, index: true },
        conversationId: { type: Schema.Types.ObjectId, ref: "Conversation", required: true, index: true },
        runId: { type: Schema.Types.ObjectId, default: null, index: true },
        outcome: { type: String, enum: ["completed", "failed", "partial"], required: true, index: true },
        whatWorked: { type: [String], default: [] },
        whatFailed: { type: [String], default: [] },
        improvements: { type: [String], default: [] },
        confidence: { type: Number, min: 0, max: 1, default: 0.5 },
        generatedByModel: { type: String, required: true, trim: true, maxlength: 120 },
        createdAt: { type: Date, default: Date.now, index: true },
    },
    { timestamps: false, versionKey: false }
);

TaskReflectionSchema.index({ taskId: 1, createdAt: -1 });
TaskReflectionSchema.index({ conversationId: 1, createdAt: -1 });

const TaskReflectionModel: Model<ITaskReflection> =
    (mongoose.models.TaskReflection as Model<ITaskReflection>)
    || mongoose.model<ITaskReflection>("TaskReflection", TaskReflectionSchema);

export default TaskReflectionModel;
