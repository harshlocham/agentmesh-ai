import { Types } from "mongoose";
import {
    assertConversationAccess,
    assertTaskAccess,
    AuthorizationError,
    canAccessConversation,
} from "../authorization.service";

jest.mock("@chat/db", () => ({
    connectToDatabase: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("@chat/db/models/Conversation", () => ({
    Conversation: {
        findById: jest.fn(),
    },
}));

jest.mock("@chat/db/models/Task", () => ({
    __esModule: true,
    default: {
        findById: jest.fn(),
    },
}));

import { Conversation } from "@chat/db/models/Conversation";
import TaskModel from "@chat/db/models/Task";

const userId = new Types.ObjectId().toString();
const otherUserId = new Types.ObjectId().toString();
const conversationId = new Types.ObjectId().toString();
const taskId = new Types.ObjectId().toString();

describe("authorization.service", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it("allows participants to access a conversation", async () => {
        (Conversation.findById as jest.Mock).mockReturnValue({
            select: jest.fn().mockReturnValue({
                lean: jest.fn().mockResolvedValue({
                    _id: new Types.ObjectId(conversationId),
                    participants: [new Types.ObjectId(userId), new Types.ObjectId(otherUserId)],
                }),
            }),
        });

        await expect(
            assertConversationAccess(userId, conversationId)
        ).resolves.toMatchObject({
            conversationId,
            participantIds: expect.arrayContaining([userId, otherUserId]),
        });
    });

    it("denies non-participants without leaking existence", async () => {
        (Conversation.findById as jest.Mock).mockReturnValue({
            select: jest.fn().mockReturnValue({
                lean: jest.fn().mockResolvedValue({
                    _id: new Types.ObjectId(conversationId),
                    participants: [new Types.ObjectId(otherUserId)],
                }),
            }),
        });

        await expect(
            assertConversationAccess(userId, conversationId)
        ).rejects.toMatchObject({
            code: "FORBIDDEN",
            message: "Forbidden",
        });
    });

    it("denies unknown conversations with the same forbidden response", async () => {
        (Conversation.findById as jest.Mock).mockReturnValue({
            select: jest.fn().mockReturnValue({
                lean: jest.fn().mockResolvedValue(null),
            }),
        });

        await expect(
            canAccessConversation(userId, conversationId)
        ).resolves.toBe(false);
    });

    it("assertTaskAccess requires conversation membership", async () => {
        (TaskModel.findById as jest.Mock).mockReturnValue({
            select: jest.fn().mockReturnValue({
                lean: jest.fn().mockResolvedValue({
                    _id: new Types.ObjectId(taskId),
                    conversationId: new Types.ObjectId(conversationId),
                }),
            }),
        });

        (Conversation.findById as jest.Mock).mockReturnValue({
            select: jest.fn().mockReturnValue({
                lean: jest.fn().mockResolvedValue({
                    _id: new Types.ObjectId(conversationId),
                    participants: [new Types.ObjectId(otherUserId)],
                }),
            }),
        });

        await expect(assertTaskAccess(userId, taskId)).rejects.toBeInstanceOf(AuthorizationError);
    });
});
