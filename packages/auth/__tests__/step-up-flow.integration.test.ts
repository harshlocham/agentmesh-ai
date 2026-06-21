import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStepUpRequiredError } from "../errors/auth-errors";

const {
    verifySessionMock,
    validateSessionFingerprintMock,
    generateDeviceFingerprintMock,
    rotateSessionTokenHashMock,
    revokeSessionMock,
    markSessionStepUpPendingMock,
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
    markSessionStepUpPendingMock: vi.fn(),
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
    markSessionStepUpPending: markSessionStepUpPendingMock,
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
    isDeleted?: boolean;
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
        markSessionStepUpPendingMock.mockResolvedValue({ _id: "session-1" });
        revokeSessionMock.mockResolvedValue({ _id: "session-1" });
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
                state: "active",
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
        expect(markSessionStepUpPendingMock).not.toHaveBeenCalled();
        expect(revokeSessionMock).not.toHaveBeenCalled();
    });

    it("2) risky refresh returns STEP_UP_REQUIRED and marks session pending (no revoke)", async () => {
        verifySessionMock.mockResolvedValue({
            payload: {
                sub: "user-2",
                sessionId: "session-risky",
                tokenVersion: 0,
            },
            session: {
                state: "active",
                userAgent: "known-agent",
                ipAddress: "10.0.0.10",
            },
        });

        validateSessionFingerprintMock.mockReturnValue({
            requiresStepUp: true,
            reasons: ["user_agent_mismatch"],
        });

        mockUserFindByIdResult({
            _id: { toString: () => "user-2" },
            role: "user",
            status: "active",
            tokenVersion: 0,
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
        // Critical: the session must be kept alive (pending), not revoked, so the
        // challenge can be completed against the same refresh session.
        expect(markSessionStepUpPendingMock).toHaveBeenCalledWith("session-risky");
        expect(revokeSessionMock).not.toHaveBeenCalled();
    });

    it("3) valid password challenge restores session to active and issues new tokens", async () => {
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
            session: { state: "step_up_pending" },
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
        // rotateSessionTokenHash is the mechanism that flips state back to active.
        expect(rotateSessionTokenHashMock).toHaveBeenCalledWith(
            "session-3",
            expect.any(String)
        );
        expect(revokeSessionMock).not.toHaveBeenCalled();
    });

    it("4) invalid password keeps the session pending and retryable", async () => {
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
            session: { state: "step_up_pending" },
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
        // Wrong credentials should NOT revoke the session; the user can retry
        // within the challenge TTL.
        expect(revokeSessionMock).not.toHaveBeenCalled();
    });

    it("5) expired challenge revokes the session", async () => {
        verifySessionMock.mockResolvedValue({
            payload: {
                sub: "user-5",
                sessionId: "session-5",
                tokenVersion: 1,
            },
            session: { state: "step_up_pending" },
        });

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
        expect(rotateSessionTokenHashMock).not.toHaveBeenCalled();
        expect(revokeSessionMock).toHaveBeenCalledWith("session-5");
    });

    it("6) consumed/invalid challenge revokes the session", async () => {
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
            session: { state: "step_up_pending" },
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
        expect(revokeSessionMock).toHaveBeenCalledWith("session-6");
    });

    it("7) otp request stores a challenge code and returns delivery details", async () => {
        verifySessionMock.mockResolvedValue({
            payload: {
                sub: "user-7",
                sessionId: "session-7",
                tokenVersion: 3,
            },
            session: { state: "step_up_pending" },
        });

        getChallengeByIdMock.mockResolvedValue({
            userId: "user-7",
            status: "pending",
            expiresAt: new Date(Date.now() + 60_000),
            otp: undefined,
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
        expect(revokeSessionMock).not.toHaveBeenCalled();
    });

    it("8) otp verification restores session to active and issues new tokens", async () => {
        verifySessionMock.mockResolvedValue({
            payload: {
                sub: "user-8",
                sessionId: "session-8",
                tokenVersion: 6,
            },
            session: { state: "step_up_pending" },
        });

        getChallengeByIdMock.mockResolvedValue({
            userId: "user-8",
            status: "pending",
            expiresAt: new Date(Date.now() + 60_000),
            otp: { hash: "otp-hash", sentAt: new Date() },
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
        expect(revokeSessionMock).not.toHaveBeenCalled();
    });

    it("9) otp verification rejects invalid codes and keeps session pending", async () => {
        verifySessionMock.mockResolvedValue({
            payload: {
                sub: "user-9",
                sessionId: "session-9",
                tokenVersion: 1,
            },
            session: { state: "step_up_pending" },
        });

        getChallengeByIdMock.mockResolvedValue({
            userId: "user-9",
            status: "pending",
            expiresAt: new Date(Date.now() + 60_000),
            otp: { hash: "otp-hash", sentAt: new Date() },
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
        expect(revokeSessionMock).not.toHaveBeenCalled();
    });

    it("10) completion is rejected when the session is not pending step-up", async () => {
        verifySessionMock.mockResolvedValue({
            payload: {
                sub: "user-10",
                sessionId: "session-10",
                tokenVersion: 1,
            },
            session: { state: "active" },
        });

        await expect(
            completePasswordStepUpChallenge({
                challengeId: "challenge-10",
                password: "correct-password",
                refreshToken: "refresh-token",
            })
        ).rejects.toThrow("Session is not pending step-up");

        // No challenge work, no rotation, and no revoke for an unsolicited completion.
        expect(getChallengeByIdMock).not.toHaveBeenCalled();
        expect(rotateSessionTokenHashMock).not.toHaveBeenCalled();
        expect(revokeSessionMock).not.toHaveBeenCalled();
    });

    it("11) missing/invalid challenge revokes the pending session", async () => {
        verifySessionMock.mockResolvedValue({
            payload: {
                sub: "user-11",
                sessionId: "session-11",
                tokenVersion: 1,
            },
            session: { state: "step_up_pending" },
        });

        getChallengeByIdMock.mockResolvedValue(null);

        await expect(
            completePasswordStepUpChallenge({
                challengeId: "challenge-11",
                password: "correct-password",
                refreshToken: "refresh-token",
            })
        ).rejects.toThrow("Challenge not found");

        expect(rotateSessionTokenHashMock).not.toHaveBeenCalled();
        expect(revokeSessionMock).toHaveBeenCalledWith("session-11");
    });
});
