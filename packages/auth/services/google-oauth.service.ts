import { randomBytes } from "node:crypto";
import { User } from "@/models/User";
import { createUserSession } from "../session/create-session";
import { generateAccessToken } from "../tokens/generate";
import type { IUser } from "@/models/User";
import { verifyGoogleIdToken } from "./google-id-token";
import type { GoogleUserProfile } from "./google-id-token";

export type { GoogleUserProfile } from "./google-id-token";

type LoginWithGoogleCodeInput = {
    code: string;
    redirectUri: string;
    state: string;
    expectedState: string;
    deviceId?: string;
    userAgent?: string;
    ipAddress?: string;
};

type GoogleTokenResponse = {
    access_token: string;
    id_token?: string;
    refresh_token?: string;
};

type AtomicGoogleUpsertResult = {
    user: IUser;
    created: boolean;
};

type ResolveGoogleUserResult = {
    user: IUser;
    created: boolean;
};

function requiredEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(`${name} is not configured`);
    }

    return value;
}

function getGoogleOAuthConfig() {
    return {
        clientId: requiredEnv("GOOGLE_CLIENT_ID"),
        clientSecret: requiredEnv("GOOGLE_CLIENT_SECRET"),
    };
}

function normalizeEmail(email: string): string {
    return email.toLowerCase().trim();
}

export function createGoogleOAuthState(): string {
    return randomBytes(24).toString("hex");
}

export function assertGoogleOAuthStateMatches(receivedState: string, expectedState: string): void {
    if (!receivedState || !expectedState || receivedState !== expectedState) {
        throw new Error("GOOGLE_OAUTH_STATE_MISMATCH");
    }
}

export function buildGoogleOAuthAuthorizeUrl({
    redirectUri,
    state,
}: {
    redirectUri: string;
    state: string;
}): string {
    const { clientId } = getGoogleOAuthConfig();

    const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: "openid email profile",
        state,
        prompt: "select_account",
        access_type: "offline",
    });

    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export async function exchangeGoogleCodeForTokens({
    code,
    redirectUri,
}: {
    code: string;
    redirectUri: string;
}): Promise<GoogleTokenResponse> {
    const { clientId, clientSecret } = getGoogleOAuthConfig();

    const response = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            code,
            grant_type: "authorization_code",
            redirect_uri: redirectUri,
        }),
    });

    if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`Google token exchange failed: ${errorBody}`);
    }

    return response.json() as Promise<GoogleTokenResponse>;
}

export async function fetchGoogleUserProfile(accessToken: string): Promise<GoogleUserProfile> {
    const response = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
        headers: {
            Authorization: `Bearer ${accessToken}`,
        },
    });

    if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`Failed to fetch Google user profile: ${errorBody}`);
    }

    return response.json() as Promise<GoogleUserProfile>;
}

export async function upsertGoogleUserByEmailAtomic(profile: GoogleUserProfile): Promise<AtomicGoogleUpsertResult> {
    const email = normalizeEmail(profile.email);

    const insertDefaults = {
        username: profile.name || email.split("@")[0],
        email,
        password: "",
        googleSub: profile.sub,
        authProviders: ["google"],
        profilePicture: profile.picture,
        role: "user",
        status: "active",
        isBanned: false,
        isDeleted: false,
        isVerified: new Date(),
        isOnline: false,
        conversations: [],
    };

    const writeResult = await User.updateOne(
        { email },
        {
            $setOnInsert: insertDefaults,
        },
        { upsert: true }
    );

    const user = await User.findOne({ email });
    if (!user) {
        throw new Error("Unable to resolve Google user account");
    }

    return {
        user,
        created: (writeResult.upsertedCount || 0) > 0,
    };
}

async function resolveGoogleUserProviderAware(
    profile: GoogleUserProfile
): Promise<ResolveGoogleUserResult> {
    const normalizedEmail = normalizeEmail(profile.email);

    // Provider subject is the strongest stable identifier for Google identities.
    const byGoogleSub = await User.findOne({ googleSub: profile.sub });
    if (byGoogleSub) {
        return { user: byGoogleSub, created: false };
    }

    // Fallback to email for existing local accounts and controlled linking flows.
    const byEmail = await User.findOne({ email: normalizedEmail });
    if (byEmail) {
        return { user: byEmail, created: false };
    }

    return upsertGoogleUserByEmailAtomic(profile);
}

async function ensureGoogleProviderLinked(user: IUser, profile: GoogleUserProfile): Promise<IUser> {
    const linkedGoogleSub = typeof user.googleSub === "string" ? user.googleSub : "";
    const providers = Array.isArray(user.authProviders) ? user.authProviders : [];
    const hasPasswordProvider = providers.includes("password") || Boolean(user.password && user.password.trim());
    const hasGoogleProvider = providers.includes("google") || Boolean(linkedGoogleSub);

    if (linkedGoogleSub && linkedGoogleSub !== profile.sub) {
        throw new Error("GOOGLE_IDENTITY_MISMATCH");
    }

    // Do not auto-link OAuth identities to password accounts.
    if (hasPasswordProvider && !hasGoogleProvider) {
        throw new Error("GOOGLE_ACCOUNT_NOT_LINKED");
    }

    const needsGoogleSub = !linkedGoogleSub;
    const needsGoogleProvider = !providers.includes("google");
    const needsPicture = !user.profilePicture && Boolean(profile.picture);

    if (!needsGoogleSub && !needsGoogleProvider && !needsPicture) {
        return user;
    }

    const filter = {
        _id: user._id,
        $or: [{ googleSub: { $exists: false } }, { googleSub: "" }, { googleSub: profile.sub }],
    };

    const setPayload: Record<string, unknown> = {};
    if (needsGoogleSub) {
        setPayload.googleSub = profile.sub;
    }
    if (needsPicture && profile.picture) {
        setPayload.profilePicture = profile.picture;
    }

    const updated = await User.findOneAndUpdate(
        filter,
        {
            ...(Object.keys(setPayload).length > 0 ? { $set: setPayload } : {}),
            ...(needsGoogleProvider ? { $addToSet: { authProviders: "google" } } : {}),
        },
        { new: true }
    );

    if (!updated) {
        throw new Error("GOOGLE_IDENTITY_MISMATCH");
    }

    return updated;
}

export async function loginWithGoogleCode({
    code,
    redirectUri,
    state,
    expectedState,
    deviceId,
    userAgent,
    ipAddress,
}: LoginWithGoogleCodeInput) {
    assertGoogleOAuthStateMatches(state, expectedState);

    const { clientId } = getGoogleOAuthConfig();
    const tokens = await exchangeGoogleCodeForTokens({ code, redirectUri });

    if (!tokens.id_token) {
        throw new Error("Google token response missing id_token");
    }

    const profile = await verifyGoogleIdToken(tokens.id_token, clientId);

    if (!profile.email || !profile.email_verified) {
        throw new Error("Google account email is missing or unverified");
    }

    const { user: existingOrCreatedUser } = await resolveGoogleUserProviderAware(profile);
    let user = await ensureGoogleProviderLinked(existingOrCreatedUser, profile);

    if (!user) {
        throw new Error("Unable to resolve Google user account");
    }

    if (user.status && user.status !== "active") {
        throw new Error("Account is not active");
    }

    if (user.isDeleted) {
        throw new Error("ACCOUNT_DELETED");
    }

    const accessToken = generateAccessToken({
        sub: user._id.toString(),
        role: user.role,
        tokenVersion: user.tokenVersion || 0,
        type: "access",
    });

    const { refreshToken } = await createUserSession({
        userId: user._id.toString(),
        deviceId,
        userAgent,
        ipAddress,
        tokenVersion: user.tokenVersion || 0,
    });

    return {
        user,
        accessToken,
        refreshToken,
    };
}
