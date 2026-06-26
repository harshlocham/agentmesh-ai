import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const {
    userFindOneMock,
    userUpdateOneMock,
    userFindOneAndUpdateMock,
    createUserSessionMock,
    generateAccessTokenMock,
} = vi.hoisted(() => ({
    userFindOneMock: vi.fn(),
    userUpdateOneMock: vi.fn(),
    userFindOneAndUpdateMock: vi.fn(),
    createUserSessionMock: vi.fn(),
    generateAccessTokenMock: vi.fn(),
}));

vi.mock("@/models/User", () => ({
    User: {
        findOne: userFindOneMock,
        updateOne: userUpdateOneMock,
        findOneAndUpdate: userFindOneAndUpdateMock,
    },
}));

vi.mock("../session/create-session", () => ({
    createUserSession: createUserSessionMock,
}));

vi.mock("../tokens/generate", () => ({
    generateAccessToken: generateAccessTokenMock,
}));

import { createGoogleOAuthState, loginWithGoogleCode } from "../services/google-oauth.service";
import { resetGoogleIdTokenVerifierCacheForTests } from "../services/google-id-token";
import {
    ensureGoogleIdTokenTestKeys,
    getGoogleTestJwksResponse,
    resolveFetchUrl,
    signGoogleTestIdToken,
} from "./helpers/google-id-token.factory";

type MockResponse<T> = {
    ok: boolean;
    status: number;
    json: () => Promise<T>;
    text: () => Promise<string>;
};

function jsonResponse<T>(data: T, status = 200): MockResponse<T> {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => data,
        text: async () => JSON.stringify(data),
    };
}

function makeUserDoc(overrides?: Partial<any>) {
    return {
        _id: { toString: () => "user-1" },
        email: "user@example.com",
        username: "user",
        role: "user",
        status: "active",
        tokenVersion: 0,
        password: "",
        googleSub: "google-sub-1",
        authProviders: ["google"],
        profilePicture: "",
        isModified: vi.fn(() => false),
        save: vi.fn(async () => undefined),
        ...overrides,
    };
}

const TEST_STATE = createGoogleOAuthState();

async function stubOAuthFetch(profile: {
    sub: string;
    email: string;
    email_verified?: boolean;
    name?: string;
    picture?: string;
}) {
    resetGoogleIdTokenVerifierCacheForTests();
    const idToken = await signGoogleTestIdToken({
        ...profile,
        email_verified: profile.email_verified ?? true,
    });

    const fetchMock = vi.fn(async (input: unknown) => {
        const url = resolveFetchUrl(input);
        if (url.includes("oauth2.googleapis.com/token")) {
            return jsonResponse({ access_token: "google-access-token", id_token: idToken });
        }
        if (url.includes("googleapis.com/oauth2/v3/certs")) {
            return jsonResponse(getGoogleTestJwksResponse());
        }
        throw new Error(`Unexpected fetch to ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    return fetchMock;
}

function loginParams(extra: Record<string, unknown> = {}) {
    return {
        code: "oauth-code",
        redirectUri: "http://localhost:3000/api/auth/google/callback",
        state: TEST_STATE,
        expectedState: TEST_STATE,
        ...extra,
    };
}

describe("google-oauth.service integration", () => {
    beforeAll(async () => {
        await ensureGoogleIdTokenTestKeys();
    });

    beforeEach(() => {
        vi.clearAllMocks();

        process.env.GOOGLE_CLIENT_ID = "test-google-client-id";
        process.env.GOOGLE_CLIENT_SECRET = "test-google-client-secret";

        userUpdateOneMock.mockResolvedValue({ upsertedCount: 0 });
        userFindOneAndUpdateMock.mockResolvedValue(null);
        generateAccessTokenMock.mockReturnValue("access-token");
        createUserSessionMock.mockResolvedValue({ refreshToken: "refresh-token" });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        resetGoogleIdTokenVerifierCacheForTests();
    });

    it("1) rejects password account login when Google is not linked", async () => {
        await stubOAuthFetch({
            sub: "google-sub-1",
            email: "user@example.com",
            name: "User",
        });

        userFindOneMock
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(
                makeUserDoc({
                    password: "hashed-password",
                    googleSub: "",
                    authProviders: ["password"],
                })
            );

        await expect(loginWithGoogleCode(loginParams())).rejects.toThrow("GOOGLE_ACCOUNT_NOT_LINKED");

        expect(userUpdateOneMock).not.toHaveBeenCalled();
        expect(createUserSessionMock).not.toHaveBeenCalled();
    });

    it("2) rejects login when existing linked Google identity mismatches", async () => {
        await stubOAuthFetch({
            sub: "google-sub-B",
            email: "user@example.com",
            name: "User",
        });

        userFindOneMock
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(
                makeUserDoc({
                    googleSub: "google-sub-A",
                    authProviders: ["google"],
                })
            );

        await expect(loginWithGoogleCode(loginParams())).rejects.toThrow("GOOGLE_IDENTITY_MISMATCH");

        expect(userUpdateOneMock).not.toHaveBeenCalled();
        expect(createUserSessionMock).not.toHaveBeenCalled();
    });

    it("3) creates a new Google user on first-time login", async () => {
        await stubOAuthFetch({
            sub: "google-sub-new",
            email: "new@example.com",
            name: "New User",
            picture: "https://example.com/avatar.png",
        });

        const createdUser = makeUserDoc({
            _id: { toString: () => "new-user-id" },
            email: "new@example.com",
            username: "New User",
            googleSub: "google-sub-new",
            authProviders: ["google"],
            profilePicture: "https://example.com/avatar.png",
            password: "",
        });

        userUpdateOneMock.mockResolvedValueOnce({ upsertedCount: 1 });
        userFindOneMock
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(createdUser);

        const result = await loginWithGoogleCode(
            loginParams({ userAgent: "test-agent", ipAddress: "127.0.0.1" })
        );

        expect(userUpdateOneMock).toHaveBeenCalledWith(
            { email: "new@example.com" },
            expect.objectContaining({
                $setOnInsert: expect.objectContaining({
                    email: "new@example.com",
                    googleSub: "google-sub-new",
                    authProviders: ["google"],
                }),
            }),
            { upsert: true }
        );
        expect(generateAccessTokenMock).toHaveBeenCalledWith(
            expect.objectContaining({ sub: "new-user-id", type: "access" })
        );
        expect(createUserSessionMock).toHaveBeenCalledWith(
            expect.objectContaining({ userId: "new-user-id" })
        );

        expect(result.user).toBe(createdUser);
        expect(result.accessToken).toBe("access-token");
        expect(result.refreshToken).toBe("refresh-token");
    });

    it("4) logs in successfully when account is already linked", async () => {
        await stubOAuthFetch({
            sub: "google-sub-1",
            email: "user@example.com",
            name: "User",
        });

        const existingLinkedUser = makeUserDoc({
            _id: { toString: () => "linked-user-id" },
            googleSub: "google-sub-1",
            authProviders: ["google"],
            isModified: vi.fn(() => false),
        });

        userUpdateOneMock.mockResolvedValueOnce({ upsertedCount: 0 });
        userFindOneMock.mockResolvedValueOnce(existingLinkedUser);

        const result = await loginWithGoogleCode(
            loginParams({ userAgent: "test-agent", ipAddress: "127.0.0.1" })
        );

        expect(userUpdateOneMock).not.toHaveBeenCalled();
        expect(generateAccessTokenMock).toHaveBeenCalledWith(
            expect.objectContaining({ sub: "linked-user-id", type: "access" })
        );
        expect(createUserSessionMock).toHaveBeenCalledWith(
            expect.objectContaining({ userId: "linked-user-id" })
        );
        expect(result.user).toBe(existingLinkedUser);
    });

    it("5) resolves account by Google subject even when email changes", async () => {
        await stubOAuthFetch({
            sub: "google-sub-1",
            email: "new-email@example.com",
            name: "User",
        });

        const existingLinkedUser = makeUserDoc({
            _id: { toString: () => "linked-user-id" },
            email: "old-email@example.com",
            googleSub: "google-sub-1",
            authProviders: ["google"],
        });

        userFindOneMock.mockResolvedValueOnce(existingLinkedUser);

        const result = await loginWithGoogleCode(
            loginParams({ userAgent: "test-agent", ipAddress: "127.0.0.1" })
        );

        expect(userUpdateOneMock).not.toHaveBeenCalled();
        expect(createUserSessionMock).toHaveBeenCalledWith(
            expect.objectContaining({ userId: "linked-user-id" })
        );
        expect(result.user).toBe(existingLinkedUser);
    });
});
