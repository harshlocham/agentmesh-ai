import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStepUpRequiredError } from "../errors/auth-errors";

const {
    verifySessionMock,
    validateSessionFingerprintMock,
    generateDeviceFingerprintMock,
    rotateSessionTokenHashMock,
    revokeSessionMock,
    createChallengeMock,
    getChallengeByIdMock,
    markChallengeVerifiedMock,
    recordChallengeOtpMock,
    comparePasswordMock,
    hashPasswordMock,
    generateAccessTokenMock,
    generateRefreshTokenMock,
    userFindByIdMock,
} = vi.hoisted(() => ({
    verifySessionMock: vi.fn(),
    validateSessionFingerprintMock: vi.fn(),
    generateDeviceFingerprintMock: vi.fn(),
    rotateSessionTokenHashMock: vi.fn(),
    revokeSessionMock: vi.fn(),
    createChallengeMock: vi.fn(),
    getChallengeByIdMock: vi.fn(),
    markChallengeVerifiedMock: vi.fn(),
    recordChallengeOtpMock: vi.fn(),
    comparePasswordMock: vi.fn(),
    hashPasswordMock: vi.fn(),
    generateAccessTokenMock: vi.fn(),
    generateRefreshTokenMock: vi.fn(),
    userFindByIdMock: vi.fn(),
}));
vi.mock("../session/verify-session", () => ({
    verifySession: verifySessionMock,
}));

vi.mock("../session/fingerprint", () => ({
    validateSessionFingerprint: validateSessionFingerprintMock,
    generateDeviceFingerprint: generateDeviceFingerprintMock,
}));

vi.mock("../repositories/session.repo", () => ({
    rotateSessionTokenHash: rotateSessionTokenHashMock,
    revokeSession: revokeSessionMock,
}));

vi.mock("@/models/StepUpChallenge", () => ({
    createChallenge: createChallengeMock,
    getChallengeById: getChallengeByIdMock,
    markChallengeVerified: markChallengeVerifiedMock,
    recordChallengeOtp: recordChallengeOtpMock,
}));

vi.mock("../password/compare", () => ({
    comparePassword: comparePasswordMock,
}));

vi.mock("../password/hash", () => ({
    hashPassword: hashPasswordMock,
}));

vi.mock("../tokens/generate", () => ({
    generateAccessToken: generateAccessTokenMock,
    generateRefreshToken: generateRefreshTokenMock,
}));

vi.mock("@/models/User", () => ({
    User: {
        findById: userFindByIdMock,
    },
}));

import { refreshService } from "../services/refresh.service";
import { completePasswordStepUpChallenge } from "../services/step-up-password.service";
import { completeOtpStepUpChallenge, requestOtpStepUpChallenge } from "../services/step-up-otp.service";

type MockUserLeanResult = {
    _id: { toString(): string };
    email?: string;
    password?: string;
    role?: "user" | "moderator" | "admin";
    status?: "active" | "banned";
    tokenVersion?: number;
} | null;

function mockUserFindByIdResult(result: MockUserLeanResult) {
    userFindByIdMock.mockReturnValue({
        select: vi.fn().mockReturnValue({
            lean: vi.fn().mockResolvedValue(result),
        }),
    });
}

describe("step-up authentication integration flow", () => {
    beforeEach(() => {
        vi.clearAllMocks();

        generateDeviceFingerprintMock.mockReturnValue("fingerprint-1");
        generateAccessTokenMock.mockReturnValue("next-access-token");
        generateRefreshTokenMock.mockReturnValue("next-refresh-token");
        rotateSessionTokenHashMock.mockResolvedValue({ _id: "session-1" });
        hashPasswordMock.mockResolvedValue("hashed-otp");
    });

    it("1) normal refresh succeeds without challenge", async () => {
        verifySessionMock.mockResolvedValue({
            payload: {
                sub: "user-1",
                sessionId: "session-1",
                tokenVersion: 2,
            },
            session: {
                userAgent: "known-agent",
                ipAddress: "10.0.0.10",
            },
        });

        validateSessionFingerprintMock.mockReturnValue({
            requiresStepUp: false,
            reasons: [],
        });

        mockUserFindByIdResult({
            _id: { toString: () => "user-1" },
            role: "user",
            status: "active",
            tokenVersion: 2,
        });

        const result = await refreshService({
            refreshToken: "refresh-token",
            userAgent: "known-agent",
            ipAddress: "10.0.0.10",
        });

        expect(result).toEqual({
            accessToken: "next-access-token",
            refreshToken: "next-refresh-token",
            userId: "user-1",
            sessionId: "session-1",
        });
        expect(createChallengeMock).not.toHaveBeenCalled();
        expect(revokeSessionMock).not.toHaveBeenCalled();
    });

    it("2) risky refresh returns STEP_UP_REQUIRED", async () => {
        verifySessionMock.mockResolvedValue({
            payload: {
                sub: "user-2",
                sessionId: "session-risky",
                tokenVersion: 0,
            },
            session: {
                userAgent: "known-agent",
                ipAddress: "10.0.0.10",
            },
        });

        validateSessionFingerprintMock.mockReturnValue({
            requiresStepUp: true,
            reasons: ["user_agent_mismatch"],
        });

        createChallengeMock.mockResolvedValue({
            _id: { toString: () => "challenge-123" },
        });

        const riskyRefreshAttempt = refreshService({
            refreshToken: "refresh-token",
            userAgent: "different-agent",
            ipAddress: "10.0.0.10",
        });

        await expect(riskyRefreshAttempt).rejects.toBeInstanceOf(AuthStepUpRequiredError);
        await expect(riskyRefreshAttempt).rejects.toMatchObject({
            code: "AUTH_STEP_UP_REQUIRED",
            challengeId: "challenge-123",
        });

        expect(createChallengeMock).toHaveBeenCalledWith("user-2", {
            ip: "10.0.0.10",
            userAgent: "different-agent",
        });
        expect(revokeSessionMock).toHaveBeenCalledWith("session-risky");
    });

    it("3) valid challenge verification issues new tokens", async () => {
        getChallengeByIdMock.mockResolvedValue({
            userId: "user-3",
            status: "pending",
            expiresAt: new Date(Date.now() + 60_000),
        });

        verifySessionMock.mockResolvedValue({
            payload: {
                sub: "user-3",
                sessionId: "session-3",
                tokenVersion: 4,
            },
        });

        mockUserFindByIdResult({
            _id: { toString: () => "user-3" },
            password: "hashed-password",
            role: "admin",
            status: "active",
            tokenVersion: 4,
        });

        comparePasswordMock.mockResolvedValue(true);
        markChallengeVerifiedMock.mockResolvedValue({ _id: "challenge-verified" });

        const result = await completePasswordStepUpChallenge({
            challengeId: "challenge-3",
            password: "correct-password",
            refreshToken: "refresh-token",
        });

        expect(result).toEqual({
            accessToken: "next-access-token",
            refreshToken: "next-refresh-token",
            userId: "user-3",
            sessionId: "session-3",
            challengeId: "challenge-3",
        });
        expect(markChallengeVerifiedMock).toHaveBeenCalledWith("challenge-3");
        expect(rotateSessionTokenHashMock).toHaveBeenCalledWith(
            "session-3",
            expect.any(String)
        );
    });

    it("4) invalid password fails verification", async () => {
        getChallengeByIdMock.mockResolvedValue({
            userId: "user-4",
            status: "pending",
            expiresAt: new Date(Date.now() + 60_000),
        });

        verifySessionMock.mockResolvedValue({
            payload: {
                sub: "user-4",
                sessionId: "session-4",
                tokenVersion: 1,
            },
        });

        mockUserFindByIdResult({
            _id: { toString: () => "user-4" },
            password: "hashed-password",
            role: "user",
            status: "active",
            tokenVersion: 1,
        });

        comparePasswordMock.mockResolvedValue(false);

        await expect(
            completePasswordStepUpChallenge({
                challengeId: "challenge-4",
                password: "wrong-password",
                refreshToken: "refresh-token",
            })
        ).rejects.toThrow("Invalid password");

        expect(markChallengeVerifiedMock).not.toHaveBeenCalled();
        expect(rotateSessionTokenHashMock).not.toHaveBeenCalled();
    });

    it("5) expired challenge is rejected", async () => {
        getChallengeByIdMock.mockResolvedValue({
            userId: "user-5",
            status: "pending",
            expiresAt: new Date(Date.now() - 1_000),
        });

        await expect(
            completePasswordStepUpChallenge({
                challengeId: "challenge-5",
                password: "any-password",
                refreshToken: "refresh-token",
            })
        ).rejects.toThrow("Challenge expired");

        expect(markChallengeVerifiedMock).not.toHaveBeenCalled();
    });

    it("6) reuse of challenge is rejected", async () => {
        getChallengeByIdMock.mockResolvedValue({
            userId: "user-6",
            status: "pending",
            expiresAt: new Date(Date.now() + 60_000),
        });

        verifySessionMock.mockResolvedValue({
            payload: {
                sub: "user-6",
                sessionId: "session-6",
                tokenVersion: 9,
            },
        });

        mockUserFindByIdResult({
            _id: { toString: () => "user-6" },
            password: "hashed-password",
            role: "user",
            status: "active",
            tokenVersion: 9,
        });

        comparePasswordMock.mockResolvedValue(true);
        markChallengeVerifiedMock.mockResolvedValue(null);

        await expect(
            completePasswordStepUpChallenge({
                challengeId: "challenge-6",
                password: "correct-password",
                refreshToken: "refresh-token",
            })
        ).rejects.toThrow("Challenge is no longer valid");

        expect(rotateSessionTokenHashMock).not.toHaveBeenCalled();
    });

    it("7) otp request stores a challenge code and returns delivery details", async () => {
        getChallengeByIdMock.mockResolvedValue({
            userId: "user-7",
            status: "pending",
            expiresAt: new Date(Date.now() + 60_000),
            otp: undefined,
        });

        verifySessionMock.mockResolvedValue({
            payload: {
                sub: "user-7",
                sessionId: "session-7",
                tokenVersion: 3,
            },
        });

        mockUserFindByIdResult({
            _id: { toString: () => "user-7" },
            email: "oauth@example.com",
            role: "user",
            status: "active",
            tokenVersion: 3,
        });

        recordChallengeOtpMock.mockResolvedValue({
            expiresAt: new Date(Date.now() + 60_000),
        });

        const result = await requestOtpStepUpChallenge({
            challengeId: "challenge-7",
            refreshToken: "refresh-token",
        });

        expect(result).toEqual({
            challengeId: "challenge-7",
            userId: "user-7",
            email: "oauth@example.com",
            otp: expect.any(String),
            expiresAt: expect.any(Date),
        });
        expect(recordChallengeOtpMock).toHaveBeenCalledWith("challenge-7", "hashed-otp");
    });

    it("8) otp verification issues new tokens", async () => {
        getChallengeByIdMock.mockResolvedValue({
            userId: "user-8",
            status: "pending",
            expiresAt: new Date(Date.now() + 60_000),
            otp: { hash: "otp-hash", sentAt: new Date() },
        });

        verifySessionMock.mockResolvedValue({
            payload: {
                sub: "user-8",
                sessionId: "session-8",
                tokenVersion: 6,
            },
        });

        mockUserFindByIdResult({
            _id: { toString: () => "user-8" },
            email: "oauth@example.com",
            role: "moderator",
            status: "active",
            tokenVersion: 6,
        });

        comparePasswordMock.mockResolvedValue(true);
        markChallengeVerifiedMock.mockResolvedValue({ _id: "challenge-verified" });

        const result = await completeOtpStepUpChallenge({
            challengeId: "challenge-8",
            otp: "123456",
            refreshToken: "refresh-token",
        });

        expect(result).toEqual({
            accessToken: "next-access-token",
            refreshToken: "next-refresh-token",
            userId: "user-8",
            sessionId: "session-8",
            challengeId: "challenge-8",
        });
        expect(markChallengeVerifiedMock).toHaveBeenCalledWith("challenge-8");
        expect(rotateSessionTokenHashMock).toHaveBeenCalledWith(
            "session-8",
            expect.any(String)
        );
    });

    it("9) otp verification rejects invalid codes", async () => {
        getChallengeByIdMock.mockResolvedValue({
            userId: "user-9",
            status: "pending",
            expiresAt: new Date(Date.now() + 60_000),
            otp: { hash: "otp-hash", sentAt: new Date() },
        });

        verifySessionMock.mockResolvedValue({
            payload: {
                sub: "user-9",
                sessionId: "session-9",
                tokenVersion: 1,
            },
        });

        mockUserFindByIdResult({
            _id: { toString: () => "user-9" },
            email: "oauth@example.com",
            role: "user",
            status: "active",
            tokenVersion: 1,
        });

        comparePasswordMock.mockResolvedValue(false);

        await expect(
            completeOtpStepUpChallenge({
                challengeId: "challenge-9",
                otp: "000000",
                refreshToken: "refresh-token",
            })
        ).rejects.toThrow("Invalid OTP");

        expect(markChallengeVerifiedMock).not.toHaveBeenCalled();
        expect(rotateSessionTokenHashMock).not.toHaveBeenCalled();
    });
});
