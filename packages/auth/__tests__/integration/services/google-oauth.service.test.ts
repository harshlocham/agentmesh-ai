import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
    loginWithGoogleCode,
    exchangeGoogleCodeForTokens,
    fetchGoogleUserProfile,
    upsertGoogleUserByEmailAtomic,
    createGoogleOAuthState,
    buildGoogleOAuthAuthorizeUrl,
    assertGoogleOAuthStateMatches,
    type GoogleUserProfile,
} from "../../../services/google-oauth.service.js";
import { resetGoogleIdTokenVerifierCacheForTests } from "../../../services/google-id-token.js";
import { verifySession } from "../../../session/verify-session.js";
import { verifyAccessToken } from "../../../tokens/verify.js";
import { User } from "../../../../db/models/User.js";
import { useTestDb } from "../../helpers/db.js";
import { createUser } from "../../helpers/factories/user.factory.js";
import {
    ensureGoogleIdTokenTestKeys,
    getGoogleTestJwksResponse,
    resolveFetchUrl,
    signGoogleTestIdToken,
} from "../../helpers/google-id-token.factory.js";

useTestDb();

const REDIRECT_URI = "https://app.test/auth/google/callback";
const TEST_OAUTH_STATE = createGoogleOAuthState();

beforeAll(async () => {
    await ensureGoogleIdTokenTestKeys();
});

type GoogleFetchOpts = {
    tokenOk?: boolean;
    tokenBody?: Record<string, unknown>;
    tokenErrorText?: string;
    profileOk?: boolean;
    profile?: Partial<GoogleUserProfile>;
    profileErrorText?: string;
    idToken?: string | null;
};

/**
 * Stub the Google HTTP boundary only. Token exchange + JWKS are external
 * third-party endpoints; everything else (Mongo upsert, session creation,
 * bcrypt, JWT signing) runs for real.
 */
async function stubGoogleFetch(opts: GoogleFetchOpts = {}): Promise<ReturnType<typeof vi.fn>> {
    const {
        tokenOk = true,
        tokenBody = {},
        tokenErrorText = "invalid_grant",
        profileOk = true,
        profile = {},
        profileErrorText = "unauthorized",
        idToken,
    } = opts;

    resetGoogleIdTokenVerifierCacheForTests();

    const resolvedProfile: GoogleUserProfile = {
        sub: profile.sub ?? "google-sub-123",
        email: profile.email ?? "person@gmail.com",
        email_verified: profile.email_verified ?? true,
        name: profile.name ?? "Test Person",
        picture: profile.picture ?? "https://pic.test/a.png",
    };

    const signedIdToken =
        idToken === null
            ? undefined
            : idToken ?? (await signGoogleTestIdToken(resolvedProfile));

    const fetchMock = vi.fn(async (input: unknown) => {
        const url = resolveFetchUrl(input);
        if (url.includes("oauth2.googleapis.com/token")) {
            return {
                ok: tokenOk,
                json: async () => ({
                    access_token: "ya29.test-access",
                    id_token: signedIdToken,
                    ...tokenBody,
                }),
                text: async () => (tokenOk ? JSON.stringify(tokenBody) : tokenErrorText),
            } as unknown as Response;
        }
        if (url.includes("googleapis.com/oauth2/v3/certs")) {
            return {
                ok: true,
                json: async () => getGoogleTestJwksResponse(),
                text: async () => JSON.stringify(getGoogleTestJwksResponse()),
            } as unknown as Response;
        }
        if (url.includes("openidconnect.googleapis.com/v1/userinfo")) {
            return {
                ok: profileOk,
                json: async () => resolvedProfile,
                text: async () => (profileOk ? JSON.stringify(resolvedProfile) : profileErrorText),
            } as unknown as Response;
        }
        throw new Error(`Unexpected fetch to ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
}

async function login(
    profile: Partial<GoogleUserProfile> = {},
    fetchOpts: GoogleFetchOpts = {},
    state: { received?: string; expected?: string } = {}
) {
    await stubGoogleFetch({ ...fetchOpts, profile: { ...fetchOpts.profile, ...profile } });
    const receivedState = state.received ?? TEST_OAUTH_STATE;
    const expectedState = state.expected ?? TEST_OAUTH_STATE;
    return loginWithGoogleCode({
        code: "auth-code",
        redirectUri: REDIRECT_URI,
        state: receivedState,
        expectedState,
        deviceId: "device-1",
        userAgent: "TestAgent/1.0",
        ipAddress: "203.0.113.5",
    });
}

afterEach(() => {
    vi.unstubAllGlobals();
    resetGoogleIdTokenVerifierCacheForTests();
});

describe("services/google-oauth.service (db integration)", () => {
    describe("happy path", () => {
        it("creates a brand-new Google user and issues a verifiable session", async () => {
            const result = await login({ sub: "sub-new", email: "New.User@Gmail.com" });

            expect(result.user.googleSub).toBe("sub-new");
            expect(result.user.email).toBe("new.user@gmail.com");
            expect(result.user.authProviders).toContain("google");
            expect(result.user.isVerified).toBeTruthy();

            // Real access + refresh tokens.
            expect(verifyAccessToken(result.accessToken).sub).toBe(result.user._id.toString());
            const { payload } = await verifySession(result.refreshToken);
            expect(payload.sub).toBe(result.user._id.toString());

            expect(await User.countDocuments({ email: "new.user@gmail.com" })).toBe(1);
        });

        it("logs in an existing Google user without creating a duplicate", async () => {
            const existing = await createUser({
                email: "returning@gmail.com",
                authProviders: ["google"],
                googleSub: "sub-existing",
            });

            const result = await login({ sub: "sub-existing", email: "returning@gmail.com" });

            expect(result.user._id.toString()).toBe(existing._id.toString());
            expect(await User.countDocuments({ email: "returning@gmail.com" })).toBe(1);
        });

        it("links Google to an existing google-provider account missing its googleSub (linking flow)", async () => {
            const existing = await createUser({
                email: "linkme@gmail.com",
                authProviders: ["google"],
                googleSub: undefined,
            });
            expect(existing.googleSub).toBeUndefined();

            const result = await login({ sub: "sub-linked", email: "linkme@gmail.com" });

            expect(result.user._id.toString()).toBe(existing._id.toString());
            expect(result.user.googleSub).toBe("sub-linked");

            const persisted = await User.findById(existing._id);
            expect(persisted?.googleSub).toBe("sub-linked");
        });
    });

    describe("failure", () => {
        it("rejects an unverified email", async () => {
            await expect(
                login({ email: "unverified@gmail.com", email_verified: false })
            ).rejects.toThrow("Google account email is missing or unverified");
        });

        it("rejects a missing email", async () => {
            await expect(
                login({ email: "", email_verified: true })
            ).rejects.toThrow("Google account email is missing or unverified");
        });

        it("rejects a banned account", async () => {
            await createUser({
                email: "banned@gmail.com",
                authProviders: ["google"],
                googleSub: "sub-banned",
                status: "banned",
            });

            await expect(
                login({ sub: "sub-banned", email: "banned@gmail.com" })
            ).rejects.toThrow("Account is not active");
        });

        it("rejects a soft-deleted account with ACCOUNT_DELETED", async () => {
            await createUser({
                email: "deleted@gmail.com",
                authProviders: ["google"],
                googleSub: "sub-deleted",
                status: "active",
                isDeleted: true,
            });

            await expect(
                login({ sub: "sub-deleted", email: "deleted@gmail.com" })
            ).rejects.toThrow("ACCOUNT_DELETED");
        });

        it("refuses to auto-link a Google identity to a password account (GOOGLE_ACCOUNT_NOT_LINKED)", async () => {
            await createUser({
                email: "pwuser@gmail.com",
                plainPassword: "s3cret-p4ss",
                authProviders: ["password"],
            });

            await expect(
                login({ sub: "sub-attacker", email: "pwuser@gmail.com" })
            ).rejects.toThrow("GOOGLE_ACCOUNT_NOT_LINKED");
        });

        it("rejects a profile sub that conflicts with the linked googleSub (GOOGLE_IDENTITY_MISMATCH)", async () => {
            await createUser({
                email: "mismatch@gmail.com",
                authProviders: ["google"],
                googleSub: "sub-original",
            });

            await expect(
                login({ sub: "sub-different", email: "mismatch@gmail.com" })
            ).rejects.toThrow("GOOGLE_IDENTITY_MISMATCH");
        });

        it("propagates a token-exchange failure", async () => {
            await stubGoogleFetch({ tokenOk: false, tokenErrorText: "invalid_grant" });
            await expect(
                exchangeGoogleCodeForTokens({ code: "bad", redirectUri: REDIRECT_URI })
            ).rejects.toThrow("Google token exchange failed: invalid_grant");
        });

        it("propagates a userinfo fetch failure", async () => {
            await stubGoogleFetch({ profileOk: false, profileErrorText: "401 unauthorized" });
            await expect(fetchGoogleUserProfile("bad-access-token")).rejects.toThrow(
                "Failed to fetch Google user profile: 401 unauthorized"
            );
        });

        it("rejects login when the OAuth state does not match", async () => {
            await expect(
                login(
                    { sub: "sub-state", email: "state@gmail.com" },
                    {},
                    { received: "received-state", expected: "stored-state" }
                )
            ).rejects.toThrow("GOOGLE_OAUTH_STATE_MISMATCH");
        });

        it("rejects login when Google omits id_token", async () => {
            await expect(
                login(
                    { sub: "sub-noid", email: "noid@gmail.com" },
                    { idToken: null }
                )
            ).rejects.toThrow("Google token response missing id_token");
        });

        it("rejects login when id_token signature verification fails", async () => {
            await expect(
                login(
                    { sub: "sub-bad", email: "bad@gmail.com" },
                    { idToken: "not-a-real-jwt" }
                )
            ).rejects.toThrow();
        });
    });

    describe("token exchange & profile fetch", () => {
        it("returns the parsed token payload on success", async () => {
            const idToken = await signGoogleTestIdToken({
                sub: "sub-token",
                email: "token@gmail.com",
            });
            await stubGoogleFetch({
                tokenBody: { access_token: "ya29.ok", id_token: idToken, refresh_token: "r" },
            });
            const tokens = await exchangeGoogleCodeForTokens({ code: "c", redirectUri: REDIRECT_URI });
            expect(tokens.access_token).toBe("ya29.ok");
            expect(tokens.id_token).toBe(idToken);
        });

        it("returns the parsed Google profile on success", async () => {
            await stubGoogleFetch({ profile: { sub: "s1", email: "p@gmail.com" } });
            const profile = await fetchGoogleUserProfile("access");
            expect(profile.sub).toBe("s1");
            expect(profile.email).toBe("p@gmail.com");
        });
    });

    describe("upsertGoogleUserByEmailAtomic", () => {
        it("creates a new user and reports created=true", async () => {
            const { user, created } = await upsertGoogleUserByEmailAtomic({
                sub: "sub-a",
                email: "Atomic@Gmail.com",
                email_verified: true,
                name: "Atomic User",
                picture: "https://pic/x.png",
            });

            expect(created).toBe(true);
            expect(user.email).toBe("atomic@gmail.com");
            expect(user.googleSub).toBe("sub-a");
            expect(user.authProviders).toContain("google");
        });

        it("does NOT clobber an existing account and reports created=false", async () => {
            const existing = await createUser({
                email: "keep@gmail.com",
                plainPassword: "keep-p4ss",
                authProviders: ["password"],
            });

            const { user, created } = await upsertGoogleUserByEmailAtomic({
                sub: "sub-b",
                email: "keep@gmail.com",
                email_verified: true,
            });

            expect(created).toBe(false);
            expect(user._id.toString()).toBe(existing._id.toString());
            // $setOnInsert did not run: googleSub remains unset, providers unchanged.
            expect(user.googleSub).toBeUndefined();
            expect(user.authProviders).toEqual(["password"]);
        });
    });

    describe("security", () => {
        it("account takeover: an unlinked password account is left untouched after a blocked Google login", async () => {
            const pw = await createUser({
                email: "victim@gmail.com",
                plainPassword: "victim-p4ss",
                authProviders: ["password"],
            });

            await expect(
                login({ sub: "sub-takeover", email: "victim@gmail.com" })
            ).rejects.toThrow("GOOGLE_ACCOUNT_NOT_LINKED");

            const persisted = await User.findById(pw._id);
            expect(persisted?.googleSub).toBeUndefined();
            expect(persisted?.authProviders).toEqual(["password"]);
        });

        it("duplicate googleSub is rejected by the partial unique index", async () => {
            await createUser({
                email: "first@gmail.com",
                authProviders: ["google"],
                googleSub: "dup-sub",
            });

            await expect(
                createUser({
                    email: "second@gmail.com",
                    authProviders: ["google"],
                    googleSub: "dup-sub",
                })
            ).rejects.toThrow(/duplicate key|E11000/);
        });

        it("concurrent first-login for the same new user yields exactly one account", async () => {
            // Two simultaneous logins for the same brand-new Google identity.
            const run = () =>
                login({ sub: "sub-race", email: "race@gmail.com" }).then(
                    () => "ok" as const,
                    (e: Error) => e.message
                );

            const [a, b] = await Promise.all([run(), run()]);

            // Exactly one account regardless of who won the upsert race.
            expect(await User.countDocuments({ email: "race@gmail.com" })).toBe(1);
            // At least one login must have succeeded.
            expect([a, b]).toContain("ok");
        });

        it("requires matching OAuth state before completing login", async () => {
            const state = createGoogleOAuthState();
            expect(state).toMatch(/^[a-f0-9]{48}$/);
            expect(createGoogleOAuthState()).not.toBe(state);

            const url = buildGoogleOAuthAuthorizeUrl({ redirectUri: REDIRECT_URI, state });
            expect(url).toContain(`state=${state}`);
            expect(url).toContain("response_type=code");
            expect(url).toContain("scope=openid+email+profile");

            expect(() => assertGoogleOAuthStateMatches("wrong", state)).toThrow(
                "GOOGLE_OAUTH_STATE_MISMATCH"
            );

            const result = await login(
                { sub: "sub-state-ok", email: "stateok@gmail.com" },
                {},
                { received: state, expected: state }
            );
            expect(result.accessToken).toBeTruthy();
        });

        it("derives identity from a verified id_token and does not call userinfo", async () => {
            const fetchMock = await stubGoogleFetch({
                profile: { sub: "sub-idtoken", email: "idtoken@gmail.com" },
            });

            const result = await loginWithGoogleCode({
                code: "auth-code",
                redirectUri: REDIRECT_URI,
                state: TEST_OAUTH_STATE,
                expectedState: TEST_OAUTH_STATE,
                deviceId: "device-1",
                userAgent: "TestAgent/1.0",
                ipAddress: "203.0.113.5",
            });

            expect(result.user.googleSub).toBe("sub-idtoken");
            expect(fetchMock).not.toHaveBeenCalledWith(
                expect.stringContaining("openidconnect.googleapis.com/v1/userinfo"),
                expect.anything()
            );
            expect(fetchMock).toHaveBeenCalledWith(
                expect.stringContaining("oauth2.googleapis.com/token"),
                expect.anything()
            );
        });

        it("FINDING: an account is matched by googleSub even when the profile email differs", async () => {
            const existing = await createUser({
                email: "stable@gmail.com",
                authProviders: ["google"],
                googleSub: "sub-stable",
            });

            // Same sub, DIFFERENT email -> resolves to the existing account and the
            // stored email is NOT updated to the new one.
            const result = await login({ sub: "sub-stable", email: "changed@gmail.com" });

            expect(result.user._id.toString()).toBe(existing._id.toString());
            expect(result.user.email).toBe("stable@gmail.com");
            expect(await User.countDocuments({ email: "changed@gmail.com" })).toBe(0);
        });
    });
});
