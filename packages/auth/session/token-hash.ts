import crypto from "crypto";

// SHA-256 is intentional here. This helper only hashes high-entropy session
// artifacts (random refresh-token JWTs), never user passwords. Slow password
// KDFs (bcrypt/Argon2) exist to make low-entropy secrets expensive to brute
// force; they add no security for high-entropy tokens and would add latency to
// every session lookup. Passwords/OTPs are hashed with bcrypt elsewhere
// (see password/hash.ts and password/compare.ts).
export function hashToken(token: string): string {
    return crypto.createHash("sha256").update(token).digest("hex");
}

export function tokenHashEquals(left: string, right: string): boolean {
    const leftBuffer = Buffer.from(left, "utf8");
    const rightBuffer = Buffer.from(right, "utf8");

    if (leftBuffer.length !== rightBuffer.length) {
        return false;
    }

    return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}