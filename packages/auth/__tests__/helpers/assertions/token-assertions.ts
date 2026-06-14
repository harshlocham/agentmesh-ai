import { expect } from "vitest";
import jwt from "jsonwebtoken";

/**
 * JWT inspection helpers for trust-layer tests.
 *
 * These decode WITHOUT verifying so tests can assert on a token's structure,
 * header, claims, and expiry independently of signature validation (which is
 * the responsibility of the code under test).
 */

type JwtHeader = { alg?: string; typ?: string } & Record<string, unknown>;
type JwtPayload = Record<string, unknown>;

/** Decode a token's payload claims (no signature verification). */
export function decodeJwt<T extends JwtPayload = JwtPayload>(token: string): T {
    const decoded = jwt.decode(token);
    if (!decoded || typeof decoded !== "object") {
        throw new Error("decodeJwt: token payload could not be decoded");
    }
    return decoded as T;
}

/** Decode a token's header (no signature verification). */
export function decodeJwtHeader(token: string): JwtHeader {
    const decoded = jwt.decode(token, { complete: true });
    if (!decoded || typeof decoded !== "object") {
        throw new Error("decodeJwtHeader: token could not be decoded");
    }
    return decoded.header as JwtHeader;
}

/** Assert the token's header `alg` matches the expected algorithm. */
export function expectAlg(token: string, alg: string): void {
    expect(decodeJwtHeader(token).alg).toBe(alg);
}

/** Assert the token carries an `exp` claim that is in the past. */
export function expectExpired(token: string): void {
    const { exp } = decodeJwt<{ exp?: number }>(token);
    expect(exp, "token is missing an exp claim").toBeTypeOf("number");
    expect(exp! * 1000).toBeLessThan(Date.now());
}

/** Assert the token carries an `exp` claim that is in the future. */
export function expectNotExpired(token: string): void {
    const { exp } = decodeJwt<{ exp?: number }>(token);
    expect(exp, "token is missing an exp claim").toBeTypeOf("number");
    expect(exp! * 1000).toBeGreaterThan(Date.now());
}

/** Assert the token's payload contains (at least) the given claim subset. */
export function expectClaims(token: string, claims: Record<string, unknown>): void {
    const payload = decodeJwt(token);
    expect(payload).toMatchObject(claims);
}
