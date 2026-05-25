import mongoose, { Model, Schema } from "mongoose";

export type TaskMemoryScope = "short_term" | "long_term";
export type TaskMemoryKind = "fact" | "pattern" | "failure" | "strategy" | "tool-feedback";

export interface ITaskMemory {
    _id: mongoose.Types.ObjectId;
    taskId?: mongoose.Types.ObjectId | null;
    conversationId?: mongoose.Types.ObjectId | null;
    scope: TaskMemoryScope;
    kind: TaskMemoryKind;
    summary: string;
    details?: string | null;
    tags: string[];
    signalStrength: number;
    successImpact: number;
    toolName?: string | null;
    expiresAt?: Date | null;
    createdAt: Date;
    updatedAt: Date;
}

const TaskMemorySchema = new Schema<ITaskMemory>(
    {
        taskId: { type: Schema.Types.ObjectId, ref: "Task", default: null, index: true },
        conversationId: { type: Schema.Types.ObjectId, ref: "Conversation", default: null, index: true },
        scope: { type: String, enum: ["short_term", "long_term"], required: true, index: true },
        kind: {
            type: String,
            enum: ["fact", "pattern", "failure", "strategy", "tool-feedback"],
            required: true,
            index: true,
        },
        summary: { type: String, required: true, trim: true, maxlength: 1200 },
        details: { type: String, trim: true, maxlength: 5000, default: null },
        tags: { type: [String], default: [] },
        signalStrength: { type: Number, min: 0, max: 1, default: 0.5, index: true },
        successImpact: { type: Number, min: -1, max: 1, default: 0 },
        toolName: { type: String, trim: true, maxlength: 120, default: null, index: true },
        expiresAt: { type: Date, default: null, index: true },
    },
    {
        timestamps: true,
        versionKey: false,
    }
);

TaskMemorySchema.index({ scope: 1, conversationId: 1, updatedAt: -1 });
TaskMemorySchema.index({ scope: 1, kind: 1, signalStrength: -1, updatedAt: -1 });
TaskMemorySchema.index({ scope: 1, toolName: 1, successImpact: -1, updatedAt: -1 });

const TaskMemoryModel: Model<ITaskMemory> =
    (mongoose.models.TaskMemory as Model<ITaskMemory>) || mongoose.model<ITaskMemory>("TaskMemory", TaskMemorySchema);

export default TaskMemoryModel;
