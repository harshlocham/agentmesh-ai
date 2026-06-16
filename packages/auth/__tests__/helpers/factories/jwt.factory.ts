import jwt, { type Algorithm } from "jsonwebtoken";
import type { AccessTokenPayload, RefreshTokenPayload } from "../../../tokens/types.js";
import { objectId } from "../ids.js";

/**
 * Low-level, adversarial JWT factory.
 *
 * Deliberately independent of the production `generateAccessToken` /
 * `generateRefreshToken` helpers so it can forge *invalid* tokens (wrong
 * secret, `alg:none`, tampered signature, expired, type-swapped) that the real
 * signers can never produce. Trust-layer tests rely on these to prove the
 * verifiers reject hostile input.
 *
 * Secrets are read from `process.env` at call time (the test env setup applies
 * defaults), with constant fallbacks so the factory works even if a test clears
 * the environment.
 */

const FALLBACK_ACCESS_SECRET = "test-access-token-secret";
const FALLBACK_REFRESH_SECRET = "test-refresh-token-secret";

function accessSecret(): string {
    return process.env.ACCESS_TOKEN_SECRET || FALLBACK_ACCESS_SECRET;
}

function refreshSecret(): string {
    return process.env.REFRESH_TOKEN_SECRET || FALLBACK_REFRESH_SECRET;
}

export interface JwtForgeOptions {
    /** Override the signing secret (used for "wrong secret" cases). */
    secret?: string;
    /** Override the algorithm (used for HS/RS confusion cases). */
    algorithm?: Algorithm;
    /** jsonwebtoken `expiresIn`; use a negative value (e.g. "-1s") for expired. */
    expiresIn?: string | number;
}

function defaultAccessPayload(): AccessTokenPayload {
    return {
        sub: objectId(),
        role: "user",
        tokenVersion: 0,
        type: "access",
    };
}

function defaultRefreshPayload(): RefreshTokenPayload {
    return {
        sub: objectId(),
        sessionId: objectId(),
        tokenVersion: 0,
        type: "refresh",
    };
}

function base64url(input: string): string {
    return Buffer.from(input, "utf8").toString("base64url");
}

function sign(
    payload: Record<string, unknown>,
    secret: string,
    options: JwtForgeOptions
): string {
    const { algorithm = "HS256", expiresIn } = options;
    return jwt.sign(payload, secret, {
        algorithm,
        ...(expiresIn !== undefined ? { expiresIn } : {}),
    });
}

function flipLastChar(value: string): string {
    const last = value[value.length - 1];
    const replacement = last === "A" ? "B" : "A";
    return value.slice(0, -1) + replacement;
}

/** Sign a valid (by default) access token, with optional payload/forge overrides. */
export function makeAccessToken(
    payload: Partial<AccessTokenPayload> = {},
    options: JwtForgeOptions = {}
): string {
    const merged = { ...defaultAccessPayload(), ...payload };
    return sign(merged, options.secret ?? accessSecret(), options);
}

/** Sign a valid (by default) refresh token, with optional payload/forge overrides. */
export function makeRefreshToken(
    payload: Partial<RefreshTokenPayload> = {},
    options: JwtForgeOptions = {}
): string {
    const merged = { ...defaultRefreshPayload(), ...payload };
    return sign(merged, options.secret ?? refreshSecret(), options);
}

/** Access token whose `exp` is already in the past. */
export function makeExpiredAccessToken(payload: Partial<AccessTokenPayload> = {}): string {
    return makeAccessToken(payload, { expiresIn: "-1s" });
}

/** Refresh token whose `exp` is already in the past. */
export function makeExpiredRefreshToken(payload: Partial<RefreshTokenPayload> = {}): string {
    return makeRefreshToken(payload, { expiresIn: "-1s" });
}

/** Access token signed with an incorrect secret. */
export function makeWrongSecretAccessToken(payload: Partial<AccessTokenPayload> = {}): string {
    return makeAccessToken(payload, { secret: "totally-wrong-secret" });
}

/** Refresh token signed with an incorrect secret. */
export function makeWrongSecretRefreshToken(payload: Partial<RefreshTokenPayload> = {}): string {
    return makeRefreshToken(payload, { secret: "totally-wrong-secret" });
}

/** A correctly-signed access token whose signature segment has been corrupted. */
export function makeTamperedAccessToken(payload: Partial<AccessTokenPayload> = {}): string {
    const token = makeAccessToken(payload);
    const [header, body, signature] = token.split(".");
    return [header, body, flipLastChar(signature)].join(".");
}

/** A correctly-signed refresh token whose signature segment has been corrupted. */
export function makeTamperedRefreshToken(payload: Partial<RefreshTokenPayload> = {}): string {
    const token = makeRefreshToken(payload);
    const [header, body, signature] = token.split(".");
    return [header, body, flipLastChar(signature)].join(".");
}

/**
 * An unsigned `alg:none` token. Built manually because production signers and
 * many jsonwebtoken paths refuse to emit `none`. Verifiers that pin HS256 must
 * reject this.
 */
export function makeAlgNoneAccessToken(payload: Partial<AccessTokenPayload> = {}): string {
    const merged = { ...defaultAccessPayload(), ...payload };
    const header = base64url(JSON.stringify({ alg: "none", typ: "JWT" }));
    const body = base64url(JSON.stringify(merged));
    // Empty signature segment, as mandated by the "none" algorithm.
    return `${header}.${body}.`;
}

/** A structurally invalid string that is not a JWT at all. */
export function makeMalformedToken(): string {
    return "not.a.jwt";
}
