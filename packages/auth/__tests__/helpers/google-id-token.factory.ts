import { exportJWK, generateKeyPair, SignJWT, createLocalJWKSet, type CryptoKey, type JWK } from "jose";
import type { GoogleUserProfile } from "../../services/google-id-token.js";
import { setGoogleJwksOverrideForTests } from "../../services/google-id-token.js";

let privateKey: CryptoKey | null = null;
let publicJwk: JWK | null = null;

export function resolveFetchUrl(input: unknown): string {
    if (typeof input === "string") {
        return input;
    }
    if (input instanceof URL) {
        return input.toString();
    }
    if (typeof input === "object" && input !== null && "url" in input) {
        return String((input as Request).url);
    }
    return String(input);
}

export async function ensureGoogleIdTokenTestKeys(): Promise<void> {
    if (privateKey && publicJwk) {
        setGoogleJwksOverrideForTests(createLocalJWKSet({ keys: [publicJwk] }));
        return;
    }

    const keys = await generateKeyPair("RS256");
    privateKey = keys.privateKey;
    const jwk = await exportJWK(keys.publicKey);
    publicJwk = {
        ...jwk,
        kid: "test-google-key",
        alg: "RS256",
        use: "sig",
    };

    setGoogleJwksOverrideForTests(createLocalJWKSet({ keys: [publicJwk] }));
}

export async function signGoogleTestIdToken(
    profile: Partial<GoogleUserProfile> & { sub?: string }
): Promise<string> {
    await ensureGoogleIdTokenTestKeys();

    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId) {
        throw new Error("GOOGLE_CLIENT_ID is not configured");
    }

    const payload: Record<string, unknown> = {
        email: profile.email ?? "person@gmail.com",
        email_verified: profile.email_verified ?? true,
    };

    if (profile.name) {
        payload.name = profile.name;
    }
    if (profile.picture) {
        payload.picture = profile.picture;
    }

    return new SignJWT(payload)
        .setSubject(profile.sub ?? "google-sub-123")
        .setIssuer("https://accounts.google.com")
        .setAudience(clientId)
        .setProtectedHeader({ alg: "RS256", kid: "test-google-key" })
        .setIssuedAt()
        .setExpirationTime("1h")
        .sign(privateKey!);
}

export function getGoogleTestJwksResponse(): { keys: JWK[] } {
    if (!publicJwk) {
        throw new Error("Call ensureGoogleIdTokenTestKeys before getGoogleTestJwksResponse");
    }

    return { keys: [publicJwk] };
}
