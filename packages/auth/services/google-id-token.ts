import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

export type GoogleUserProfile = {
    sub: string;
    email: string;
    email_verified: boolean;
    name?: string;
    picture?: string;
};

const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];
const GOOGLE_JWKS_URL = new URL("https://www.googleapis.com/oauth2/v3/certs");

let googleJwks: JWTVerifyGetKey | null = null;
let googleJwksOverrideForTests: JWTVerifyGetKey | null = null;

function getGoogleJwks(): JWTVerifyGetKey {
    if (googleJwksOverrideForTests) {
        return googleJwksOverrideForTests;
    }

    if (!googleJwks) {
        googleJwks = createRemoteJWKSet(GOOGLE_JWKS_URL);
    }
    return googleJwks;
}

function isEmailVerified(value: unknown): boolean {
    return value === true || value === "true";
}

export async function verifyGoogleIdToken(
    idToken: string,
    clientId: string
): Promise<GoogleUserProfile> {
    const { payload } = await jwtVerify(idToken, getGoogleJwks(), {
        issuer: GOOGLE_ISSUERS,
        audience: clientId,
    });

    if (typeof payload.sub !== "string" || !payload.sub) {
        throw new Error("Google id_token missing subject");
    }

    const email = typeof payload.email === "string" ? payload.email : "";

    return {
        sub: payload.sub,
        email,
        email_verified: isEmailVerified(payload.email_verified),
        name: typeof payload.name === "string" ? payload.name : undefined,
        picture: typeof payload.picture === "string" ? payload.picture : undefined,
    };
}

/** Reset cached JWKS between tests that stub fetch. */
export function resetGoogleIdTokenVerifierCacheForTests(): void {
    googleJwks = null;
    googleJwksOverrideForTests = null;
}

export function setGoogleJwksOverrideForTests(jwks: JWTVerifyGetKey | null): void {
    googleJwksOverrideForTests = jwks;
    googleJwks = null;
}
