import mongoose, { Model, Schema } from "mongoose";

export interface IMessageIntent {
    _id: mongoose.Types.ObjectId;
    messageId: mongoose.Types.ObjectId;
    conversationId: mongoose.Types.ObjectId;
    intentType: "request" | "commit" | "reminder" | "decision" | "question" | "info";
    entities: {
        actionVerb: string;
        objectText: string;
        assigneeUserIds: mongoose.Types.ObjectId[];
        dueAtCandidate?: Date | null;
        priorityCandidate: "low" | "medium" | "high" | "urgent" | "";
    };
    confidence: number;
    extractorVersion: string;
    rawSummary: string;
    createdAt: Date;
}

const MessageIntentSchema = new Schema<IMessageIntent>(
    {
        messageId: { type: Schema.Types.ObjectId, ref: "Message", required: true, unique: true, index: true },
        conversationId: { type: Schema.Types.ObjectId, ref: "Conversation", required: true, index: true },
        intentType: {
            type: String,
            enum: ["request", "commit", "reminder", "decision", "question", "info"],
            required: true,
            index: true,
        },
        entities: {
            actionVerb: { type: String, trim: true, maxlength: 64, default: "" },
            objectText: { type: String, trim: true, maxlength: 512, default: "" },
            assigneeUserIds: [{ type: Schema.Types.ObjectId, ref: "User" }],
            dueAtCandidate: { type: Date, default: null },
            priorityCandidate: {
                type: String,
                enum: ["low", "medium", "high", "urgent", ""],
                default: "",
            },
        },
        confidence: { type: Number, min: 0, max: 1, required: true },
        extractorVersion: { type: String, required: true, maxlength: 64, index: true },
        rawSummary: { type: String, trim: true, maxlength: 4000, default: "" },
        createdAt: { type: Date, default: Date.now, index: true },
    },
    { timestamps: false, strict: true }
);

MessageIntentSchema.index({ conversationId: 1, intentType: 1, createdAt: -1 });

const MessageIntentModel: Model<IMessageIntent> =
    (mongoose.models.MessageIntent as Model<IMessageIntent>) || mongoose.model<IMessageIntent>("MessageIntent", MessageIntentSchema);

export default MessageIntentModel;