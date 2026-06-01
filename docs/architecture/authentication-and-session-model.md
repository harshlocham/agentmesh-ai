# Authentication and Session Model

## Purpose

`packages/auth` is the single source of authentication logic for the platform.
It serves three trust planes:

1. The Next.js web app (`apps/web/app/api/auth/*` route handlers).
2. The Socket.IO transport process (`apps/socket`) via the access-token
   handshake.
3. The task worker (`apps/task-worker`), indirectly, by validating tokens on
   outbound calls into the web app.

The package implements **stateless access tokens** + **stateful refresh
sessions** with **device-bound fingerprinting**, optional **OTP**-based
email verification, optional **Google OAuth**, **password and OTP step-up**
challenges, and **token-version-based revocation**.

This document describes the lifecycle, persistence boundaries, and trust
properties. Socket authorization specifics live in
[ADR-003](../decisions/ADR-003-socket-authorization-bridge.md).

## Responsibilities

- Generate, verify, and rotate access/refresh JWTs.
- Persist refresh sessions in MongoDB with hashed token, device fingerprint,
  TTL.
- Detect fingerprint drift and escalate to a step-up challenge.
- Issue OTPs to email for registration and step-up.
- Audit every auth event in a queryable log.
- Provide HTTP and socket middleware shims for downstream services.

## Trust Model

The system is built on two distinct token classes, **issued separately and
verified independently**.

| Class | Algorithm | Secret | TTL | Stored? | Purpose |
|---|---|---|---|---|---|
| Access | HS256 | `ACCESS_TOKEN_SECRET` | 15 min | No (bearer-only) | Per-request auth on REST and socket. |
| Refresh | HS256 | `REFRESH_TOKEN_SECRET` | 7 days | Yes, **hashed** | Mint new access tokens; bound to a `Session` document. |

Both secrets are required at startup (`packages/auth/config.ts:requiredEnv`)
and are read once into `authConfig` via lazy getters. Cookie names are
fixed: `accessToken`, `refreshToken`. Cookie config (`secure`, `httpOnly`,
`sameSite`) is centralized in `getCookieConfig()` and toggles by
`NODE_ENV`.

Token payload structure (`packages/auth/tokens/types.ts`):

```ts
type AccessTokenPayload  = { sub, role, tokenVersion, type: "access"  };
type RefreshTokenPayload = { sub, role, tokenVersion, type: "refresh", sessionId };
```

Algorithm pinning is **explicit** at every verification site
(`jwt.verify(token, secret, { algorithms: ["HS256"] })`). Type field gating
prevents access-token misuse on refresh routes and vice versa.

### tokenVersion as the global revocation switch

`User.tokenVersion` is monotonically incremented to invalidate every token
ever issued for that user. Both refresh and access verification require
`token.tokenVersion === user.tokenVersion`. There are two writers:

- `invalidateAllUserTokens(userId, reason)` in
  `packages/auth/tokens/invalidate.ts`. Increments the version and
  `deleteUserSessions(userId)` for explicit revocation
  (password change, account compromise, suspicious activity).
- `revokeUserAuthSessions(userId)` in `services/revoke-user-auth.service.ts`.
  Same primitives, intended for admin/security flows.

Because the version check happens server-side, **a stolen access token can be
invalidated mid-flight** by bumping the version. The token will continue to
verify cryptographically until the validator queries the user record and
finds a higher version.

## Session Persistence

`SessionModel` (`packages/auth/repositories/sessionModel.ts`):

```
{
  _id: ObjectId,
  userId: ObjectId   (indexed),
  refreshTokenHash: String  (select: false),
  deviceId?: String,
  userAgent?: String,
  ipAddress?: String,
  deviceFingerprint?: String,
  expiresAt: Date    (TTL index: expireAfterSeconds: 0),
  revokedAt?: Date,
  createdAt, updatedAt
}
```

Critical properties:

- `refreshTokenHash` is hashed with SHA-256 (`session/token-hash.ts`) and
  marked `select: false` so it never leaks via accidental projection. The
  raw refresh token is **never** stored.
- `expiresAt` has an `expireAfterSeconds: 0` TTL index → MongoDB
  auto-deletes expired sessions. There is no garbage-collection process
  the application owns.
- `deviceFingerprint` is computed from `(deviceId, userAgent, ipBucket)`
  with `/24` IP bucketing (see Fingerprinting). It is hashed (SHA-256) to
  keep raw values out of session storage.

### Session creation

`createUserSession(input)` in `packages/auth/session/create-session.ts`:

1. Generate `sessionId = randomBytes(16).toString("hex")`.
2. Call `generateRefreshToken({ sub, role, tokenVersion, type: "refresh",
   sessionId })`.
3. Hash the raw refresh token via `hashToken(...)`.
4. Compute `deviceFingerprint = generateDeviceFingerprint(...)`.
5. `createSession({ ... })` writes the document with `expiresAt = now + 7d`.
6. Return `{ refreshToken, session }`. The raw token is returned **once** to
   be set as an HTTP-only cookie.

### Session verification (refresh path)

`verifySession({ refreshToken })` in
`packages/auth/session/verify-session.ts`:

1. `verifyRefreshToken(refreshToken)` — JWT signature, `type === "refresh"`,
   extract `{ sub, sessionId, tokenVersion, role }`.
2. `findSessionByIdWithToken(sessionId)` — fetch session **with**
   `refreshTokenHash` (overrides `select: false`).
3. Existence + ownership: session exists, `userId === sub`.
4. `revokedAt === null` and `expiresAt > now`.
5. `tokenHashEquals(refreshToken, session.refreshTokenHash)` — constant-time
   comparison after re-hashing. If false the token is either forged or has
   been rotated out from under the holder. This is the **session-hijack
   detection** point.

## Refresh Flow

`refreshUserSession({ refreshToken, deviceId, userAgent, ipAddress })` in
`packages/auth/services/refresh.service.ts`:

```
┌────────────────────────────────────────────────────────────────────┐
│ verifySession(refreshToken)                                         │
│   └── On failure: throw → 401, no session changes.                  │
│                                                                      │
│ validateSessionFingerprint(storedFingerprint,                        │
│                            { deviceId, userAgent, ipAddress })       │
│   ├── deviceMismatch?                                                │
│   ├── userAgentMismatch? (Bot, Header)                               │
│   └── ipBucketMismatch?  (/24)                                       │
│         │                                                            │
│         └── requiresStepUp?                                          │
│               └── createChallenge(userId, {ip, userAgent})           │
│                     and throw AuthStepUpRequiredError(challengeId)   │
│                                                                      │
│ Fetch user; verify user.tokenVersion === token.tokenVersion          │
│   └── Mismatch → throw "Token has been invalidated"                  │
│                                                                      │
│ generateRefreshToken({...})  → newRefreshToken                       │
│ generateAccessToken({...})   → newAccessToken                        │
│ rotateSessionTokenHash(sessionId, hashToken(newRefreshToken),        │
│                        now + 7d)                                     │
│                                                                      │
│ logAuthEventBestEffort("refresh_success" | "refresh_failed")         │
└────────────────────────────────────────────────────────────────────┘
```

The rotation is **always** done on a successful refresh — there is no
re-use window. A single refresh token is a one-shot credential. Reuse of an
older refresh token after rotation results in
`tokenHashEquals → false` on the next verify (because the hash in the DB now
matches the **new** token). This converts refresh-token theft into an
observable signal: the legitimate client and the attacker race; the loser
gets `Invalid refresh token`.

The system does **not** explicitly classify this as "session hijack
detected → revoke all" — it returns 401 to whichever client made the second
call. A stronger defense would be to detect the mismatch and bump
`tokenVersion`, killing all sessions. This is documented as Technical Debt
below.

## Fingerprinting

`packages/auth/session/fingerprint.ts`:

- `normalizeDeviceId(value?)` — lowercase trimmed, or `"unknown"`.
- `normalizeUserAgent(value?)` — lowercase trimmed, with normalization for
  webview/bot variants, or `"unknown"`.
- `normalizeIpBucket(value?)` — IPv4 → `/24` (`a.b.c.0`), IPv6 → first
  4 groups, or `"unknown"`. The `/24` bucket reduces false positives when
  a user's IP changes within the same NAT/CGN range.

`generateDeviceFingerprint(input)` → SHA-256 over the three normalized
fields, hex-encoded.

`validateSessionFingerprint(stored, input)` returns:

```ts
{ requiresStepUp: boolean, deviceMismatch, userAgentMismatch, ipBucketMismatch }
```

The `requiresStepUp` predicate is the boolean OR of the three
mismatches, scoped so that **first-time refresh** (no stored fingerprint)
does not trigger step-up.

When `requiresStepUp` is true, the refresh service creates a
`StepUpChallenge` row, attaches IP/UA metadata, and throws
`AuthStepUpRequiredError(reasons, challengeId, userId)`. The API layer
maps this to a 403 with the `challengeId`; the client then routes to a
step-up endpoint.

## Step-Up Challenges

`StepUpChallenge` model (`packages/db/models/StepUpChallenge.ts`):

- TTL: 5 minutes (`STEP_UP_TTL_MS`), enforced by MongoDB
  `expireAfterSeconds: 0` index.
- `status`: `pending` → `verified` | `expired`.
- `verificationMethod`: `"password"` (default) or `"otp"`.
- `otp.hash` + `otp.sentAt` populated when the user opts to use OTP.

There are two completion paths:

### Password step-up

`completePasswordStepUpChallenge(input)` in
`services/step-up-password.service.ts`:

1. `getChallengeById(challengeId)` (lazy-expires if past TTL).
2. Validate `status === "pending"`, `userId === challenge.userId`.
3. `comparePassword(password, user.password)` (bcrypt via
   `packages/auth/password/compare.ts`).
4. `markChallengeVerified(challengeId)` — atomic
   `findOneAndUpdate` with `status: "pending"` predicate (so a
   concurrent expiration loses to verification).
5. **Rotate the refresh session**:
   `rotateSessionTokenHash(sessionId, newHash, now + 7d)`.
6. Return a freshly-signed access token + refresh token.

### OTP step-up

`services/step-up-otp.service.ts`:

`requestOtpStepUpChallenge(challengeId)`:

1. Generate a 6-digit OTP via `crypto.randomInt`.
2. `hashOtp(otp)` (SHA-256, salted with `OTP_HASH_SECRET`).
3. `recordChallengeOtp(challengeId, hash)` writes
   `{ otp.hash, otp.sentAt, verificationMethod: "otp" }` to the
   challenge — only if it is still `pending` and not expired.
4. `sendOtpEmail(user.email, otp)`.

`completeOtpStepUpChallenge({ challengeId, otp })`:

1. `getChallengeById` + status/expiry validation.
2. `compareHashedOtp(otp, challenge.otp.hash)` — constant-time.
3. `markChallengeVerified`.
4. `rotateSessionTokenHash` + issue new tokens.

Both paths converge on the **same outcome**: a fresh refresh token bound to
the same `sessionId`, with the `deviceFingerprint` on the session **not
updated**. This means a successful step-up unblocks the immediate refresh
but the next request from the same drifted device will trigger a *new*
step-up unless `deviceFingerprint` is also rotated. The current code does
not rotate it. This is documented as Technical Debt.

## OTP Service (Registration / Email Verification)

`packages/auth/services/otp.service.ts` provides:

- `sendEmailOtpService(email)` → 6-digit OTP, hashed and persisted in
  `Otp` model, then `sendOtpEmail`. `OTP_COOLDOWN_MS` prevents resends
  within the cooldown window.
- `verifyEmailOtpService({ email, otp })` → finds the most recent un-used
  OTP for the email, validates expiry (`OTP_EXPIRY_MS`), validates the
  hash via constant-time compare, and marks it consumed.
- `verifyOtpAndRegisterService({ email, otp, name, password? })` →
  combines verification with `register.service.ts:registerUserService` or
  retrieval of an existing user.

The OTP table uses a unique compound index that intentionally allows multiple
OTPs per email over time (cooldown-bounded); on verification, the latest is
used.

## Login Paths

| Path | File | Output |
|---|---|---|
| Password | `services/login.service.ts` | `{ accessToken, refreshToken, user }` |
| Google OAuth | `services/google-oauth.service.ts:loginWithGoogleCode` | Same; auto-links by `googleSub`, never by email-only (`ensureGoogleProviderLinked` rejects with `GOOGLE_ACCOUNT_NOT_LINKED` if a password account exists without a `googleSub`). |
| OTP-only registration | `verifyOtpAndRegisterService` | Same. |

All paths funnel through `createUserSession`, so refresh-token rotation and
fingerprinting work identically regardless of how the user authenticated.

## Logout

`services/logout.service.ts`:

- Default: `deleteSession(sessionId)` — removes only the current session.
  Other devices remain logged in until their refresh tokens expire or a
  full revocation runs.
- `logoutFromAllDevices: true`:
  `invalidateAllUserTokens(userId, "user_logout_all")` →
  `User.tokenVersion += 1` + `deleteUserSessions(userId)`. **Every access
  token previously issued is invalidated on next server check**, and every
  refresh session is gone.

## Audit Log

`services/auth-audit.service.ts` writes to `AuthEventModel`
(`repositories/authEventModel.ts`). Every login, refresh, logout, OAuth,
password change, step-up, and revocation emits one row with:

- `eventType` (one of 20 enum values).
- `outcome: "success" | "failure"`.
- `userId` (if known), `email`, `ipAddress`, `userAgent`, `reason`,
  `metadata`.

The write is **best-effort**: if the DB connection is not ready
(`connection.readyState !== 1`) the write is silently skipped. Errors are
caught and `console.error`'d but never thrown — auth flows never fail
because the audit log is down. This is the right tradeoff for availability
but means alerting must compare audit-log counts against application
metrics to detect log loss.

Indexes on `(eventType, createdAt)`, `(userId, createdAt)`, `(createdAt)`
support common queries.

## Middleware Surface

`packages/auth/middleware/`:

- `http-auth.ts:authenticateHttpBearer(header)` — Parses
  `Authorization: Bearer ...`, calls `verifyAccessToken`, returns
  `{ userId, role, tokenVersion }`. Does **not** check
  `User.tokenVersion` against the DB; callers (e.g. Next.js route
  handlers) are expected to do that themselves if they care about
  mid-flight revocation.
- `socket-auth.ts:authenticateSocketToken(token)` — same verify wrapper
  for the socket process's pre-bridge check. The DB check happens in the
  socket process via `authorizeSocketIdentity` (see ADR-003).

The split is intentional: `packages/auth` knows JWTs; the **caller**
decides whether to additionally check `tokenVersion` against the DB. The
socket server always does (via the bridge). REST endpoints typically rely
on a Next.js middleware (not in this package) that calls the same
helper.

## Configuration

`packages/auth/config.ts`:

- `requiredEnv(name)` throws if env var is missing.
- `getAccessTokenConfig()` → `{ secret, expiresIn: "15m" }`.
- `getRefreshTokenConfig()` → `{ secret, expiresIn: "7d" }`.
- `getSessionConfig()` → `{ ttlMs: 7 * 24 * 60 * 60 * 1000 }`.
- `getCookieConfig()` → cookie names and `{ httpOnly, secure, sameSite }`
  toggled by `NODE_ENV === "production"`.
- All wrapped in `authConfig` object whose getters lazy-evaluate; this lets
  tests stub env vars before the first read.

Hard-coded constants the user should know about:

- Access token TTL: `15m` (`tokens/generate.ts:9`).
- Refresh token TTL: `7d` (`tokens/generate.ts:21`).
- Session TTL: `7d` (matches refresh TTL).
- Step-up TTL: `5m` (`StepUpChallenge.ts:27`).
- OTP cooldown: `OTP_COOLDOWN_MS` env, default 60s (verify in
  `otp.service.ts`).
- OTP expiry: `OTP_EXPIRY_MS` env.

## Tradeoffs

- **Stateless access + stateful refresh**. Standard pattern; 15-min
  access TTL caps the blast radius of a stolen access token. The 7-day
  refresh TTL is generous; reducing it would increase user friction.
- **`/24` IP bucketing**. False-negative rate (drift detection misses) is
  higher than per-IP fingerprinting, but the user-experience cost of
  flagging every mobile IP change is much worse. Documented in
  `fingerprint.ts`.
- **One-shot refresh rotation**. Rotating on every refresh prevents
  reuse, at the cost of "double-tap refresh" failures (network glitches
  that cause the client to re-send the same refresh). The server has no
  retry-safe re-issue window.
- **`tokenVersion` instead of per-token revocation list**. A single bump
  invalidates *all* tokens; you cannot revoke a single device without
  bumping the version (which would log out all devices). Single-device
  logout is therefore session-based only, and a stolen access token from
  device X cannot be revoked without taking down device Y.
- **OTP-hash storage on the challenge**. The challenge document holds the
  OTP hash directly rather than referencing the `Otp` table. This couples
  the step-up flow to its own OTP storage but avoids cross-table joins on
  the hot path.
- **Best-effort audit logging**. Auth never fails due to logging failures.
  Audit completeness is therefore not guaranteed; production must
  cross-check audit row counts against application metrics.

## Failure Handling

| Failure | Behavior |
|---|---|
| Refresh JWT signature invalid | `verifySession` throws `Invalid refresh token` → 401. |
| Refresh JWT shape invalid (missing `sessionId`, wrong `type`) | Same as above. |
| Session not found or revoked | `Session not found` / `Session has been revoked` → 401. |
| Session expired | `Session expired` → 401. Also auto-deleted by TTL index. |
| Refresh hash mismatch (token rotated or forged) | `Invalid refresh token` → 401. No revocation cascade. |
| `tokenVersion` mismatch | `Token has been invalidated` → 401. |
| Fingerprint mismatch | `AuthStepUpRequiredError(challengeId)` → 403; client must complete step-up. |
| Step-up password wrong | Throws → caller maps to 401. Challenge stays `pending` until TTL. |
| Step-up OTP expired | Lazy-expired by `getChallengeById`. |
| User banned / deleted mid-session | Caught by `authorizeSocketIdentity` bridge call on next socket op; REST routes must call `validateAuthUserById` themselves. |
| MongoDB unreachable | `verifySession` rejects (cannot find session); audit log silently skipped; auth halts. |

## Scalability Considerations

- Refresh path requires a session document read + a hashed compare + a
  rotate write — three round-trips to MongoDB per refresh. With a single
  refresh every 15 minutes per active user, this is bounded but should
  not be ignored at scale. `findSessionByIdWithToken` is indexed by `_id`.
- The `User` collection is read on every refresh for the
  `tokenVersion` check. This is a single keyed lookup (indexed) but it is
  on the hot path; consider a short-TTL Redis cache keyed on
  `(userId, tokenVersion)` similar to `validateAuthUserById` in the
  socket bridge.
- `AuthEventModel` writes are append-only and unbounded in size. A
  retention strategy (TTL index on `createdAt`?) is **not** in the model.
- Session TTL is enforced by Mongo at sweep time, so cluster-wide growth
  is bounded by `activeUsers × deviceCount`.

## Technical Debt / Limitations

1. **Refresh-hash mismatch is not treated as a security event**. A stolen
   refresh token races with the legitimate user. The loser sees 401. A
   stronger response is to bump `tokenVersion` on detected mismatch and
   log a `step_up_triggered` event with reason `refresh_reuse`. Today,
   the loss is silent.
2. **Step-up does not update the session fingerprint**. After a successful
   step-up the next refresh from the same drifted device triggers
   step-up again. Either the session should adopt the new fingerprint or
   the user-experience should reflect "trust this device" with explicit
   re-fingerprinting on opt-in.
3. **No revocation list for individual tokens**. The only revocation
   primitives are session deletion (this session) and `tokenVersion` bump
   (all sessions). Per-device revocation requires either of these.
4. **`AuthEventModel` has no TTL**. Without a retention policy, the
   audit log grows unbounded.
5. **`authenticateHttpBearer` does not check `tokenVersion` against the
   DB**. Web routes that depend on instant revocation must wrap the
   middleware with an extra check. The socket process does this in the
   bridge; REST does not have a uniform pattern.
6. **Google OAuth account linking is by exact `googleSub` only**.
   `ensureGoogleProviderLinked` will reject if a password account exists
   for the same email without a `googleSub` — this is the safe default,
   but UX-wise the user sees `GOOGLE_ACCOUNT_NOT_LINKED` with no
   recourse outside `/api/auth/link/google-link` (which lives in the web
   app, not here).
7. **No mTLS or asymmetric JWT (e.g. RS256)**. HS256 with shared secrets
   is fine for internal-only verifiers but rules out third-party token
   consumers.

## Future Evolution

- Add `tokenVersion` bump on refresh-hash mismatch (cheapest theft
  defense).
- Cache `(userId → tokenVersion)` in Redis with a short TTL for the
  refresh hot path; invalidate on `invalidateAllUserTokens`.
- Switch refresh JWT signature to RS256 if external services need to
  verify without holding `REFRESH_TOKEN_SECRET`.
- Add a TTL or archival job on `AuthEventModel`.
- Consider per-device opaque refresh tokens (random 256-bit string +
  session id) instead of JWTs; the JWT carries no useful info that isn't
  already stored on the session row, and an opaque token shortens
  exposure if the secret leaks.
- Plumb step-up completion to refresh the device fingerprint on the
  session.

## Uncertain

- The exact behavior of `validateAuthUserById` (referenced by the socket
  bridge) is not in `packages/auth`; it lives in
  `apps/web/lib/utils/auth/`. Its caching strategy was inspected during
  socket review but is not centralized in this package.
- The HTTP middleware in this package is a thin verifier; the
  user-facing route handlers in `apps/web/app/api/auth/*` add cookie
  handling, CSRF, and rate limiting (rate limiting was not
  exhaustively traced).
- The Google OAuth `state` cookie validation is performed in the route
  handler, not in `google-oauth.service.ts`. A cross-check of the route
  is needed to confirm CSRF protection on the OAuth callback.
