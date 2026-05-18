// models/Conversation.ts
// models/Conversation.ts
import mongoose, { Schema, model, Document, Types, Model } from 'mongoose';
import { IUser } from './User.js';

export interface ILastMessage {
    _id: Types.ObjectId;
    sender: Types.ObjectId | IUser;
    messageType: 'text' | 'image' | 'video' | 'file' | 'system' | 'audio' | 'voice';
    content?: string;
    _creationTime: Date;
}

export interface IConversation extends Document {
    _id: mongoose.Types.ObjectId;
    _creationTime: Date | undefined;
    admin: string;
    participants: (Types.ObjectId | IUser)[];   // 🆕 Allow ObjectId or IUser
    type: 'direct' | 'group';
    isGroup: boolean;
    isOnline?: boolean;
    name?: string;
    image?: string;
    groupName?: string;
    lastMessage?: ILastMessage;
    createdAt: Date;
    updatedAt: Date;
}


const conversationSchema = new Schema<IConversation>({
    participants: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    type: { type: String, enum: ['direct', 'group'], default: 'direct' },
    isGroup: { type: Boolean, default: false },
    admin: { type: String },
    name: { type: String },
    image: { type: String },
    groupName: { type: String },
    isOnline: { type: Boolean, default: false },
    lastMessage: {
        _id: { type: Schema.Types.ObjectId, ref: 'Message' },
        sender: { type: Schema.Types.ObjectId, ref: 'User' },
        messageType: {
            type: String,
            enum: ['text', 'image', 'video', 'file', 'system', 'audio', 'voice']
        },
        content: { type: String },
        _creationTime: { type: Date }
    }
}, {
    timestamps: true
});

conversationSchema.index({ participants: 1 });
conversationSchema.index({ _id: 1, participants: 1 });

export interface IConversationPopulated extends IConversation {
    participants: IUser[];
}

export const Conversation: Model<IConversation> =
    (mongoose.models.Conversation as Model<IConversation>) || model<IConversation>('Conversation', conversationSchema);
