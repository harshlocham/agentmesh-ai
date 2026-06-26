import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { getAccessTokenConfig, getRefreshTokenConfig } from "../config";
import { AccessTokenPayload, RefreshTokenPayload } from "./types";

export function generateAccessToken(payload: AccessTokenPayload): string {
    const config = getAccessTokenConfig();
    return jwt.sign(payload, config.secret, {
        expiresIn: config.expiresIn,
        algorithm: "HS256",
    });
}

export function generateRefreshToken(payload: RefreshTokenPayload): string {
    const config = getRefreshTokenConfig();
    // A unique jti guarantees rotation produces a new JWT even when identity
    // claims and iat fall in the same second (HS256 would otherwise be identical).
    return jwt.sign(payload, config.secret, {
        expiresIn: config.expiresIn,
        algorithm: "HS256",
        jwtid: crypto.randomUUID(),
    });
}