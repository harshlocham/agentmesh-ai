import mongoose, { Document, Model, Schema } from "mongoose";

export interface IContact extends Document {
    _id: mongoose.Types.ObjectId;
    userId: mongoose.Types.ObjectId;
    name: string;
    email: string;
    aliases: string[];
    createdAt: Date;
    updatedAt: Date;
}

const ContactSchema = new Schema<IContact>(
    {
        userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
        name: { type: String, required: true, trim: true, maxlength: 200 },
        email: { type: String, required: true, trim: true, lowercase: true, maxlength: 320 },
        aliases: { type: [String], default: [] },
    },
    {
        timestamps: true,
        versionKey: false,
    }
);

ContactSchema.index({ userId: 1, email: 1 }, { unique: true, name: "uniq_contact_user_email" });
ContactSchema.index({ userId: 1, name: 1 }, { name: "idx_contact_user_name" });

const ContactModel: Model<IContact> =
    (mongoose.models.Contact as Model<IContact>) || mongoose.model<IContact>("Contact", ContactSchema);

export default ContactModel;
