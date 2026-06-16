import { afterEach, describe, expect, it, vi } from "vitest";
import { Types } from "mongoose";
import { loginUser } from "../../services/login.service.js";
import { refreshService } from "../../services/refresh.service.js";
import { logoutService } from "../../services/logout.service.js";
import { changePasswordService } from "../../services/change-password.service.js";
import { completePasswordStepUpChallenge } from "../../services/step-up-password.service.js";
import { loginWithGoogleCode } from "../../services/google-oauth.service.js";
import { verifySession } from "../../session/verify-session.js";
import { verifyAccessToken } from "../../tokens/verify.js";
import { AuthStepUpRequiredError } from "../../errors/auth-errors.js";
import { findSessionById } from "../../repositories/session.repo.js";
import { SessionModel } from "../../repositories/sessionModel.js";
import { User } from "../../../db/models/User.js";
import { useTestDb } from "../helpers/db.js";
import { createUser } from "../helpers/factories/user.factory.js";
import {
    buildRequestContext,
    driftedContext,
} from "../helpers/factories/request-context.factory.js";

useTestDb();

const PASSWORD = "lifecycle-p4ssword";
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const ROTATION_DELAY_MS = 1200;

function countSessions(userId: string): Promise<number> {
    return SessionModel.countDocuments({ userId: new Types.ObjectId(userId) });
}

function stubGoogleFetch(profile: {
    sub: string;
    email: string;
    email_verified?: boolean;
    name?: string;
    picture?: string;
}) {
    vi.stubGlobal(
        "fetch",
        vi.fn(async (input: unknown) => {
            const url = String(input);
            if (url.includes("oauth2.googleapis.com/token")) {
                return {
                    ok: true,
                    json: async () => ({ access_token: "ya29.x", id_token: "i.d.t" }),
                    text: async () => "",
                } as unknown as Response;
            }
            if (url.includes("openidconnect.googleapis.com/v1/userinfo")) {
                return {
                    ok: true,
                    json: async () => ({ email_verified: true, ...profile }),
                    text: async () => "",
                } as unknown as Response;
            }
            throw new Error(`Unexpected fetch to ${url}`);
        })
    );
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("auth lifecycle (e2e integration)", () => {
    it("Flow 1: Login -> Refresh -> Logout", async () => {
        const ctx = buildRequestContext();
        await createUser({ email: "flow1@test.dev", plainPassword: PASSWORD });

        const loggedIn = await loginUser({ email: "flow1@test.dev", password: PASSWORD, ...ctx });
        const userId = loggedIn.user._id.toString();
        expect(verifyAccessToken(loggedIn.accessToken).sub).toBe(userId);
        expect(await countSessions(userId)).toBe(1);

        const refreshed = await refreshService({ refreshToken: loggedIn.refreshToken, ...ctx });
        expect(refreshed.userId).toBe(userId);
        const { payload } = await verifySession(refreshed.refreshToken);
        expect(payload.sub).toBe(userId);

        const logout = await logoutService({ refreshToken: refreshed.refreshToken });
        expect(logout.allDevices).toBe(false);
        expect(logout.userId).toBe(userId);

        // Session is gone; the (rotated) token no longer resolves.
        expect(await countSessions(userId)).toBe(0);
        await expect(verifySession(refreshed.refreshToken)).rejects.toThrow("Invalid session");
    });

    it("Flow 2: Login -> Refresh (drift) -> Step-Up -> Completion", async () => {
        const ctx = buildRequestContext();
        await createUser({ email: "flow2@test.dev", plainPassword: PASSWORD });

        const loggedIn = await loginUser({ email: "flow2@test.dev", password: PASSWORD, ...ctx });
        const userId = loggedIn.user._id.toString();

        // Refresh from a drifted device triggers step-up (session kept pending).
        const stepUpError = (await refreshService({
            refreshToken: loggedIn.refreshToken,
            ...driftedContext(ctx),
        }).catch((e: unknown) => e)) as AuthStepUpRequiredError;

        expect(stepUpError).toBeInstanceOf(AuthStepUpRequiredError);
        const challengeId = stepUpError.challengeId!;

        const { payload } = await verifySession(loggedIn.refreshToken);
        const session = await findSessionById(payload.sessionId);
        expect(session?.state).toBe("step_up_pending");

        // Complete step-up with the original refresh token + password.
        const completed = await completePasswordStepUpChallenge({
            challengeId,
            password: PASSWORD,
            refreshToken: loggedIn.refreshToken,
        });
        expect(completed.userId).toBe(userId);

        const restored = await findSessionById(payload.sessionId);
        expect(restored?.state).toBe("active");
        // New refresh token issued by completion is usable.
        const { payload: newPayload } = await verifySession(completed.refreshToken);
        expect(newPayload.sessionId).toBe(payload.sessionId);
    });

    it("Flow 3: Login -> Change Password -> Token Revocation", async () => {
        const ctx = buildRequestContext();
        const user = await createUser({ email: "flow3@test.dev", plainPassword: PASSWORD });
        const userId = user._id.toString();

        const loggedIn = await loginUser({ email: "flow3@test.dev", password: PASSWORD, ...ctx });
        expect(await countSessions(userId)).toBe(1);

        const newPassword = "brand-new-p4ssword";
        await changePasswordService({ userId, oldPassword: PASSWORD, newPassword });

        // Change password deletes sessions and bumps tokenVersion -> the old
        // refresh token is dead.
        expect(await countSessions(userId)).toBe(0);
        await expect(
            refreshService({ refreshToken: loggedIn.refreshToken, ...ctx })
        ).rejects.toThrow("Invalid session");

        const persisted = await User.findById(userId).select("tokenVersion").lean<{ tokenVersion?: number } | null>();
        expect(persisted?.tokenVersion).toBe(1);

        // The old password no longer logs in; the new one does.
        await expect(
            loginUser({ email: "flow3@test.dev", password: PASSWORD, ...ctx })
        ).rejects.toThrow("Invalid password");
        const reLoggedIn = await loginUser({ email: "flow3@test.dev", password: newPassword, ...ctx });
        expect(reLoggedIn.user._id.toString()).toBe(userId);
    });

    it("Flow 4: Google Login -> Refresh -> Logout", async () => {
        const ctx = buildRequestContext();
        stubGoogleFetch({ sub: "flow4-sub", email: "flow4@gmail.com" });

        const loggedIn = await loginWithGoogleCode({
            code: "code",
            redirectUri: "https://app.test/cb",
            ...ctx,
        });
        const userId = loggedIn.user._id.toString();
        expect(await countSessions(userId)).toBe(1);

        const refreshed = await refreshService({ refreshToken: loggedIn.refreshToken, ...ctx });
        expect(refreshed.userId).toBe(userId);

        const logout = await logoutService({ refreshToken: refreshed.refreshToken });
        expect(logout.allDevices).toBe(false);
        expect(await countSessions(userId)).toBe(0);
        await expect(verifySession(refreshed.refreshToken)).rejects.toThrow("Invalid session");
    });

    it("Flow 5: TokenVersion Revocation Flow", async () => {
        const ctxA = buildRequestContext({ deviceId: "device-A" });
        const ctxB = buildRequestContext({ deviceId: "device-B" });
        const user = await createUser({ email: "flow5@test.dev", plainPassword: PASSWORD });
        const userId = user._id.toString();

        const deviceA = await loginUser({ email: "flow5@test.dev", password: PASSWORD, ...ctxA });
        const deviceB = await loginUser({ email: "flow5@test.dev", password: PASSWORD, ...ctxB });
        expect(await countSessions(userId)).toBe(2);

        // Logout-all-devices from device A: bumps tokenVersion + deletes sessions.
        const logoutAll = await logoutService({
            refreshToken: deviceA.refreshToken,
            logoutFromAllDevices: true,
        });
        expect(logoutAll.allDevices).toBe(true);
        expect(logoutAll.tokenVersionBefore).toBe(0);
        expect(logoutAll.tokenVersionAfter).toBe(1);
        expect(await countSessions(userId)).toBe(0);

        // Device B's still-held refresh token is now rejected (session removed).
        await expect(
            refreshService({ refreshToken: deviceB.refreshToken, ...ctxB })
        ).rejects.toThrow("Invalid session");

        // And a fresh login carries the new tokenVersion in its access token.
        const reLoggedIn = await loginUser({ email: "flow5@test.dev", password: PASSWORD, ...ctxA });
        expect(verifyAccessToken(reLoggedIn.accessToken).tokenVersion).toBe(1);
    });

    it("Flow 5b: out-of-band tokenVersion bump revokes the session on next refresh", async () => {
        const ctx = buildRequestContext();
        const user = await createUser({ email: "flow5b@test.dev", plainPassword: PASSWORD });
        const userId = user._id.toString();

        const loggedIn = await loginUser({ email: "flow5b@test.dev", password: PASSWORD, ...ctx });
        const { payload } = await verifySession(loggedIn.refreshToken);

        // Simulate an out-of-band revocation that bumps tokenVersion but leaves
        // the session row in place.
        await User.updateOne({ _id: user._id }, { $inc: { tokenVersion: 1 } });

        await expect(
            refreshService({ refreshToken: loggedIn.refreshToken, ...ctx })
        ).rejects.toThrow("Token version revoked");

        // The mismatch defensively revokes the stale session.
        const session = await findSessionById(payload.sessionId);
        expect(session?.revokedAt).toBeInstanceOf(Date);
        expect(userId).toBe(payload.sub);
    });

    it("Flow 6: Session Replay Protection Flow", async () => {
        const ctx = buildRequestContext();
        await createUser({ email: "flow6@test.dev", plainPassword: PASSWORD });

        const loggedIn = await loginUser({ email: "flow6@test.dev", password: PASSWORD, ...ctx });

        await sleep(ROTATION_DELAY_MS);
        const rotated = await refreshService({ refreshToken: loggedIn.refreshToken, ...ctx });
        expect(rotated.refreshToken).not.toBe(loggedIn.refreshToken);

        // Replaying the original (pre-rotation) token is rejected...
        await expect(
            refreshService({ refreshToken: loggedIn.refreshToken, ...ctx })
        ).rejects.toThrow("Invalid session token");

        // ...while the rotated token continues to work.
        const again = await refreshService({ refreshToken: rotated.refreshToken, ...ctx });
        expect(again.accessToken).toBeTruthy();
    });
});
