jest.mock("@chat/types/utils/internal-bridge-auth", () => ({
    INTERNAL_SECRET_HEADER: "x-internal-secret",
    getInternalSecret: () => "test-secret",
    hasValidInternalSecret: (provided: string | null | undefined) => provided === "test-secret",
}));

class MockAuthorizationError extends Error {
    code = "FORBIDDEN";
}

jest.mock("@chat/services/authorization.service", () => ({
    assertConversationAccess: jest.fn(),
    AuthorizationError: MockAuthorizationError,
}));

import { assertConversationAccess } from "@chat/services/authorization.service";
import { POST } from "../app/api/internal/socket/authorize-conversation-access/route";

describe("POST /api/internal/socket/authorize-conversation-access", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it("rejects requests without internal secret", async () => {
        const response = await POST(
            new Request("http://localhost/api/internal/socket/authorize-conversation-access", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ userId: "u1", conversationId: "c1" }),
            })
        );

        expect(response.status).toBe(401);
    });

    it("returns participant ids for authorized socket bridge calls", async () => {
        (assertConversationAccess as jest.Mock).mockResolvedValue({
            conversationId: "c1",
            participantIds: ["u1", "u2"],
        });

        const response = await POST(
            new Request("http://localhost/api/internal/socket/authorize-conversation-access", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "x-internal-secret": "test-secret",
                },
                body: JSON.stringify({ userId: "u1", conversationId: "c1" }),
            })
        );

        const body = await response.json();
        expect(response.status).toBe(200);
        expect(body).toEqual({
            allowed: true,
            participantIds: ["u1", "u2"],
        });
    });

    it("returns forbidden without distinguishing missing conversations", async () => {
        (assertConversationAccess as jest.Mock).mockRejectedValue(
            new MockAuthorizationError("Forbidden")
        );

        const response = await POST(
            new Request("http://localhost/api/internal/socket/authorize-conversation-access", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "x-internal-secret": "test-secret",
                },
                body: JSON.stringify({ userId: "u1", conversationId: "missing" }),
            })
        );

        expect(response.status).toBe(403);
        await expect(response.json()).resolves.toEqual({
            allowed: false,
            reason: "forbidden",
        });
    });
});
