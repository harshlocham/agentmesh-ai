# 🔐 Production Security Audit: Authentication System
## Chat App JWT+Session Architecture

**Audit Date:** March 2026  
**Scope:** Packages/auth, apps/socket middleware, apps/web middleware, session management  
**Standard:** STRIDE threat modeling with invariant validation and cross-layer consistency checks

---

# PART 1: SYSTEM MODEL

## 1.1 Authentication Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    CLIENT (Web/Socket)                       │
└────────────────┬──────────────────────────┬──────────────────┘
                 │                          │
        ┌────────┴─────────┐        ┌──────┴────────┐
        ▼                  ▼        ▼               ▼
    [HTTP Layer]      [Middleware]  [Socket]   [Internal API]
        │                  │         │             │
        │              (JWT+Role)   (Token)   (Auth Bridge)
        │                  │         │             │
    ┌───┴──────────────────┼─────────┼─────────────┤
    ▼                      ▼         │             │
[Login/Register]      [Page Gate]    │             │
    │                  [Admin Gate]  │             │
    │                      │         │             │
    └──────────────────────┼─────────┼─────────────┤
                           ▼         ▼             ▼
                        ┌──────────────────────────────┐
                        │    Auth Services Layer       │
                        │  (Login, Refresh, Logout)    │
                        └────────────┬─────────────────┘
                                     │
                    ┌────────────────┴─────────────┐
                    ▼                              ▼
              ┌──────────────┐          ┌─────────────────┐
              │  JWT Tokens  │          │  Sessions (DB)  │
              │  HS256       │          │  Token Hash     │
              │  15m/7d TTL  │          │  Revocation     │
              └──────────────┘          │  Binding        │
                                        └─────────────────┘
                                                 │
                                                 ▼
                                        ┌──────────────────┐
                                        │  MongoDB Users   │
                                        │  (SOT: Status)   │
                                        └──────────────────┘
```

## 1.2 Authentication Entry Points

| Entry Point | Purpose | Auth Mechanism | Trust Source |
|-------------|---------|-----------------|--------------|
| **POST /auth/register** | Create user account | Email + password | None (open) |
| **POST /auth/login** | Credential auth | Email + password → DB lookup | DB verified password hash |
| **POST /auth/refresh** | Token renewal | Refresh token + session hash | DB session state |
| **POST /auth/logout** | Session invalidation | Refresh token + session | DB session state |
| **POST /auth/google/callback** | OAuth identity | Google code → profile | Google OpenID + DB |
| **Socket handshake** | Real-time connection | Access token from header/auth/cookie | Token signature + DB validation |
| **GET /admin/** | Admin-only pages | Access token + role check | Token role + DB revalidation |
| **POST /api/internal/socket/authorize-identity** | Cross-layer identity | INTERNAL_SECRET header | Internal secret + DB |

## 1.3 Trust Boundaries

### Boundary 1: Client ↔ API

- **What crosses:** Access tokens (JWT HS256), refresh tokens (JWT HS256 in cookies)
- **Trust model:** Tokens are signed proof of identity but NOT authoritative
- **Enforcement:** Signature verified, claims validated, then DB-backed identity revalidated for critical operations

### Boundary 2: API ↔ Database (Single Source of Truth)

- **What crosses:** User lookups, session queries, status checks
- **Trust model:** DB is authoritative; token is only cached identity
- **Enforcement:** Every refresh, logout-all, admin gate revalidates against DB

### Boundary 3: Web ↔ Socket (Cross-Layer Consistency)

- **What crosses:** User identity validation
- **Trust model:** Socket cannot trust token role directly (stale); must query DB via internal bridge
- **Enforcement:** Socket middleware calls `/api/internal/socket/authorize-identity` with INTERNAL_SECRET

### Boundary 4: Internal APIs (Service-to-Service)

- **What crosses:** Sensitive identity state (user status, role)
- **Trust model:** Authenticated via INTERNAL_SECRET header (not public)
- **Enforcement:** Constant-time secret comparison, rate limited per IP

### Boundary 5: Session ↔ Refresh Token

- **What crosses:** Session ID, token hash
- **Trust model:** Token hash must match DB hash (prevents token replay after rotation)
- **Enforcement:** Hash comparison in `verifySession()` before any auth decision

## 1.4 Data Flow: Identity Lifecycle

### Flow 1: Initial Login

```
User: email + password
    ↓
loginService:
    - Normalize email (lowercase)
    - Find user in DB
    - CLS: Verify password ✓
    - Check status === "active" ✓
    - Generate access token (sub: userId, role: from DB)
    - Generate refresh token (sessionId, type: refresh)
    ↓
createUserSession:
    - Hash refresh token
    - Create session record in DB (refreshTokenHash, expiresAt, userId)
    ↓
Return: accessToken + refreshToken (in secure cookie)
```

**Trust checks:**
- ✅ Normalized email prevents duplicate logical accounts
- ✅ Status checked BEFORE token issuance
- ✅ Session DB state immediately reflects user's current status

---

### Flow 2: Token Refresh

```
Client: refreshToken (from cookie)
    ↓
refreshService:
    - Parse refresh token (algo: HS256)
    - Validate signature + claims (type: "refresh", sessionId, sub)
    - Lookup session in DB (findSessionByIdWithToken)
    - CLS: Verify token hash matches DB hash ✓ (prevents stale token)
    - Verify session.userId === token.sub (prevents binding bypass)
    - Verify session NOT revoked
    - Verify session NOT expired
    - Lookup user by token.sub in DB
    - Check user exists (prevents deleted user token reuse)
    - Check status === "active" (prevents banned user token reuse)
    ↓
Generate new access token:
    - Issue new access token with current role from DB
    ↓
Rotate session token hash:
    - Generate new refresh token
    - Hash it + store in session DB
    - Increment session version implicitly
    ↓
Return: new access + refresh tokens
```

**Trust checks:**
- ✅ Token hash rotation prevents replay of old refresh tokens
- ✅ User existence + status checked immediately before issuance
- ✅ Session binding enforced (userId match)
- ✅ Role read from fresh DB, not cached in token

---

### Flow 3: Socket Connection

```
Client: access token (from header/auth/cookie)
    ↓
socketAuth middleware:
    - Extract token from header/auth/cookie
    - Verify signature (algo: HS256, exp check)
    - Validate claims (type: "access", sub present)
    ↓
authorizeSocketIdentity (cross-layer bridge):
    - Call POST /api/internal/socket/authorize-identity
    - Verify INTERNAL_SECRET header (constant-time compare)
    - Lookup user in DB by userId
    - Check user exists
    - Check status === "active"
    ↓
Set socket.data:
    - socket.data.userId = user._id
    - socket.data.isAdmin = response.role === "admin"
    ↓
Connection established
```

**Trust checks:**
- ✅ Token signature verified (prevents tampered claims)
- ✅ User status revalidated at connection time (fresh DB state)
- ✅ Token role is IGNORED; DB role used instead (prevents stale admin status)

---

### Flow 4: Admin Page Access

```
Client: access token (cookie)
    ↓
nextMiddleware:
    - Verify token (algo: HS256)
    - Extract sub from token
    - Token role is NOT trusted
    ↓
hasActiveAdminRole:
    - Call POST /api/internal/socket/authorize-identity
    - Verify INTERNAL_SECRET header
    - Lookup user in DB
    - Check status === "active" && role === "admin"
    - Use cache: "no-store" (always fresh)
    ↓
Decision: Redirect or allow
```

**Trust checks:**
- ✅ Admin role revalidated on EVERY request (prevents stale downgrade)
- ✅ No-store cache ensures DB state is always current

---

### Flow 5: Logout

```
Client: refreshToken (from cookie)
    ↓
logoutService:
    - Call verifySession(refreshToken)
    - Verify token signature + claims
    - Lookup session in DB + validate hash match
    - Verify session NOT already revoked
    - Verify user binding (session.userId === token.sub)
    ↓
Case A: Logout current device only
    - Delete individual session by sessionId
    - Next refresh with old token → "Session not found"
    ↓
Case B: Logout all devices
    - Call deleteUserSessions(userId)
    - Delete ALL sessions for user
    - All old tokens → "Session not found"
    ↓
Return: Success
```

**Trust checks:**
- ✅ Requires FULL session validation (not just signature)
- ✅ Prevents stale token reuse for logout-all (e.g., rotated token can't trigger global logout)

---

## 1.5 Token Schema

### Access Token Payload

```json
{
  "sub": "user_id_string",         // User ID (subject)
  "role": "user|moderator|admin",  // Current role (from DB)
  "type": "access",                // Claim validation
  "iat": 1234567890,               // Issued at (JWT std)
  "exp": 1234569690                // Expires in 15 minutes
}
```

**Claims validated:**
- `type === "access"` (prevents refresh token misuse)
- `sub` is string (prevents null/undefined)
- `role` in enum OR truthy (optional on refresh, verified in socket/admin gates)
- `iat` within bounds (JWT validation)
- `exp` not exceeded (JWT validation)

### Refresh Token Payload

```json
{
  "sub": "user_id_string",         // User ID (subject)
  "sessionId": "session_id_string", // Session ID in DB
  "type": "refresh",               // Claim validation
  "iat": 1234567890,               // Issued at
  "exp": 1234569690                // Expires in 7 days
}
```

**Claims validated:**
- `type === "refresh"` (prevents access token misuse)
- `sub` is string
- `sessionId` is string
- Session must exist in DB with matching token hash

---

## 1.6 Session State Model

Each session record in DB:

```typescript
{
  _id: ObjectId,                    // Session ID
  userId: ObjectId,                 // User this session belongs to
  refreshTokenHash: string,         // SHA256(refreshToken) - prevents replay
  userAgent: string,                // Device identifier
  ipAddress: string,                // Login location
  expiresAt: Date,                  // 7 days from creation/refresh
  revokedAt?: Date,                 // Set on logout
  lastActiveAt: Date,               // Track session freshness
  createdAt: Date,                  // Session creation timestamp
}
```

**Invariants:**
- Token hash changes with every refresh (prevents old token replay)
- `revokedAt` is immutable once set (logout cannot be undone)
- `expiresAt` extends on every successful refresh
- `userId` binds token to specific user (prevents session hijacking)

---

# PART 2: THREAT MODEL (STRIDE) WITH REAL VULNERABILITIES

## 2.1 Spoofing (Can attacker impersonate a user?)

### Threat 2.1.1: Direct JWT Forgery

**Scenario:** Attacker crafts JWT with arbitrary `sub` and `role` claims.

**Attack:**
```javascript
// Attacker creates forged token without valid signature
const forged = jwt.sign(
  { sub: "admin_id", role: "admin", type: "access" },
  "wrong_secret", // Not the real ACCESS_TOKEN_SECRET
  { algorithm: "HS256", expiresIn: "15m" }
);

// Submit to API
fetch("/api/...", { headers: { Authorization: `Bearer ${forged}` } });
```

**System Defense:**
- ✅ **PROTECTED:** JWT verification requires correct `ACCESS_TOKEN_SECRET` (HS256)
- ✅ **PROTECTED:** Algorithm restricted to HS256 only (line 13 in `verify.ts`)
- ✅ **Code:** `jwt.verify(token, config.secret, { algorithms: ["HS256"] })`

**Remaining Risk:** NONE - Cannot forge without secret. Secret rotation would invalidate old tokens (standard practice).

---

### Threat 2.1.2: Algorithm Substitution Attack (None Algorithm)

**Scenario:** Attacker sends token with `alg: "none"` to bypass signature.

**Attack:**
```javascript
// Craft JWT with no signature
const forged = jwt.sign(
  { sub: "admin_id", role: "admin", type: "access" },
  "",
  { algorithm: "none" }
);
// Some JWT libs accept this!
```

**System Defense:**
- ✅ **PROTECTED:** Algorithm explicitly restricted to `["HS256"]`
- ✅ **Code:** `algorithms: ["HS256"]` in both `packages/auth/tokens/verify.ts` and `apps/socket/server/socket/middleware/auth.ts`
- ✅ **Protected:** `apps/web/middleware.ts` also uses `algorithms: ["HS256"]`

---

### Threat 2.1.3: Stolen Token Misuse (Access Token as Refresh Token)

**Scenario:** Attacker steals access token, tries to use as refresh token.

**Attack:**
```javascript
// Access token has type: "access"
const stolenAccessToken = "eyJhbGc..."; // type: "access"

// Try to refresh with it
const response = verifyRefreshToken(stolenAccessToken);
// If verify only checked signature, this would work!
```

**System Defense:**
- ✅ **PROTECTED:** Type claim strictly validated
- ✅ **Code:** `if (payload.type !== "refresh")` in `packages/auth/tokens/verify.ts` line 33
- ✅ Also prevents refresh token misuse as access token

**Remaining Risk:** NONE - Type claim is mandatory and validated before any use.

---

### Threat 2.1.4: Session Hijacking (Stolen Refresh Token Reuse)

**Scenario:** Attacker obtains refresh token (via XSS, network sniffing, etc.), uses it multiple times.

**Attack:**
```javascript
// Attacker steals refresh token from cookie
const stolenRefreshToken = "eyJhbGc..."; // type: "refresh", sessionId: "xyz"

// First use: Get new tokens
POST /auth/refresh with stolenRefreshToken
→ Server finds session with sessionId "xyz"
→ Verifies token hash matches DB
→ Issues new tokens
→ Rotates token hash in DB

// Second use: Attacker tries to use OLD stolen token again
POST /auth/refresh with stolenRefreshToken (SAME old one)
→ Server finds session with sessionId "xyz"
→ Tries to verify token hash...
→ Hashes stolen token → Hash A
→ Compares with DB → Hash B (from first legitimate refresh)
→ Hash A !== Hash B
→ ✅ REJECTED: "Invalid session token"
```

**System Defense:**
- ✅ **PROTECTED:** Token hash rotation on every refresh
- ✅ **Code:** `rotateSessionTokenHash()` in `packages/auth/repositories/session.repo.ts` line 35
- ✅ Only the current token hash is valid

**Remaining Risk:** NONE - Hash rotation prevents replay of old tokens. One replay attempt would reveal compromise.

---

### Threat 2.1.5: User Deletion / Account Ban Bypass

**Scenario:** Attacker holds valid access token, but account is deleted/banned after login. Attacker uses old access token + refresh token.

**Attack:**
```javascript
// User logs in and gets access token
const validToken = "eyJhbGc..."; // type: "access", sub: "user_123"

// Admin bans the user
await User.updateOne({ _id: "user_123" }, { status: "banned" });

// Attacker tries to use old access token for API calls
GET /api/user/profile with validToken
→ Middleware verifies signature ✓
→ Extracts sub: "user_123"
→ BUT: No DB validation in HTTP API layer! ✗
→ Allows request ✓ (VULNERABILITY)

// Later, token expires. Attacker refreshes
POST /auth/refresh with refreshToken
→ Server calls refreshService
→ Looks up user by payload.sub
→ Checks user.status !== "active"
→ ✅ REJECTED: "Account is not active"
```

**System Defense:**
- ✅ **PROTECTED (Refresh):** User status checked before issuing new token
- ✅ **Code:** `if (user.status && user.status !== "active")` in `packages/auth/services/refresh.service.ts` line 11
- ⚠️ **VULNERABLE (HTTP API):** Access token used directly without DB revalidation
  - Banned user can use old access token until expiry (15 minutes)
  - No revalidation in generic API layer

**Remaining Risk:** **HIGH** - Banned user can act for 15 minutes with valid access token. Access tokens need expiry or layer checking.

**Why not caught by current system:**
- HTTP API doesn't have a blanket auth middleware that revalidates status
- Only Socket + Admin gate revalidate against DB
- Generic API endpoints trust token expiry alone

---

## 2.2 Tampering (Can tokens or sessions be modified or reused?)

### Threat 2.2.1: JWT Claim Injection

**Scenario:** Attacker modifies JWT payload claims (e.g., change role from "user" to "admin").

**Attack:**
```javascript
// Original token payload
{ sub: "user_123", role: "user", type: "access" }

// Attacker tries to modify before verification
const parts = token.split(".");
// Decode and modify payload
const modifiedPayload = btoa(JSON.stringify({ sub: "user_123", role: "admin", type: "access" }));
const tamperedToken = parts[0] + "." + modifiedPayload + "." + parts[2];

// Submit with tampering
GET /admin with tamperedToken
```

**System Defense:**
- ✅ **PROTECTED:** JWT signature validates entire payload
- ✅ If payload changed, HMAC signature invalid
- ✅ **Code:** `jwt.verify()` enforces signature check

**Remaining Risk:** NONE - HMAC signature prevents modification.

---

### Threat 2.2.2: Token Rotation Bypass (Prevent Stale Token Replay)

**Scenario:** Attacker intercepts a refresh token at T1, then tries to use it at T2 after legitimate refresh at T1.5.

**Attack:**
```javascript
// T=1: Attacker steals refresh token A
stolenToken_A = hash("refreshToken_A")

// T=1.5: Legitimate client refreshes (unaware of compromise)
POST /auth/refresh with stolenToken_A  (LEGITIMATE USE, still valid at this moment)
→ Server rotates token hash in DB
→ Stores hash("refreshToken_B") in session
→ Returns new refreshToken_B to legitimate client

// T=2: Attacker intercepts old refresh token and tries to use it
POST /auth/refresh with stolenToken_A
→ Server computes hash("stolenToken_A")
→ Looks in DB session → hash("refreshToken_B")
→ hash("stolenToken_A") !== hash("refreshToken_B")
→ ✅ REJECTED: "Invalid session token"
```

**System Defense:**
- ✅ **PROTECTED:** Token hash in DB updated on every refresh
- ✅ Old token hash immediately invalidated
- ✅ **Code:** Line 35-46 in `packages/auth/repositories/session.repo.ts`

**Remaining Risk:** NONE - Rotation prevents replay after single legitimate use.

---

### Threat 2.2.3: Session Revocation Bypass

**Scenario:** Attacker holds refresh token, admin revokes session via logout, attacker still tries to use old token.

**Attack:**
```javascript
// Admin logs out user (all devices)
await logoutService({ refreshToken, logoutFromAllDevices: true });
→ Finds session
→ Calls deleteUserSessions(userId) 
→ All sessions deleted from DB
→ DB now has NO sessions for this user

// Attacker tries to use old refresh token
POST /auth/refresh with oldRefreshToken (sessionId: "abc123")
→ Server calls verifySession(oldRefreshToken)
→ Tries to find session by ID: await findSessionByIdWithToken("abc123")
→ Returns null (session deleted)
→ ✅ REJECTED: "Invalid session"
```

**System Defense:**
- ✅ **PROTECTED:** Logout deletes all sessions immediately
- ✅ No revokedAt timestamp race condition (immediate deletion)
- ✅ **Code:** `deleteUserSessions()` in repositories

**Remaining Risk:** NONE - Immediate deletion prevents reuse.

---

### Threat 2.2.4: Logout-All Triggered by Stale Token (Critical Invariant)

**Scenario:** Attacker obtains an OLD refresh token (rotated out), uses it to trigger logout-all-devices.

**Attack (if system only checked signature):**
```javascript
// T=1: User logs in
session_1 = { sessionId: "xyz", tokenHash("old_token") }

// T=2: User refreshes (rotates token)
User calls /auth/refresh with old_token
→ New session created OR old hash updated
→ session_1 now has tokenHash("new_token")

// T=3: Attacker intercepts OLD token (from before rotation)
stolenToken = old_token

// T=4: Attacker tries logout-all-devices with OLD token
POST /logout with { logoutFromAllDevices: true, refreshToken: old_token }

// If system only checks JWT signature:
if (payload.type === "refresh") {  // ✓ Valid signature
  deleteUserSessions(payload.sub);  // ✓ Deletes ALL sessions
  // ATTACKER HAS DDoS'D LEGITIMATE USER
}
```

**Current System Defense:**
- ✅ **PROTECTED:** Logout calls `verifySession()`, not just `verifyRefreshToken()`
- ✅ **Code:** Line 7 in `packages/auth/services/logout.service.ts`
  ```typescript
  const { payload } = await verifySession(refreshToken);
  ```
- ✅ `verifySession()` verifies token hash match against DB
- ✅ Old token has different hash than current session hash → REJECTED

**Remaining Risk:** NONE - Full session validation required for logout.

---

## 2.3 Repudiation (Are actions traceable to real user?)

### Threat 2.3.1: OAuth Account Linkage

**Scenario:** Two users with same email—one via password, one via OAuth—become conflated.

**Attack:**
```javascript
// User A registers with email: alice@example.com + password
User.create({ email: "alice@example.com", password: hash("pwd123") })

// User B tries to login via Google with SAME email
// Google API returns { email: "alice@example.com", email_verified: true }
// System normalizes to "alice@example.com"
// System searches: User.findOne({ email: "alice@example.com" })
// FOUND! (User A)
// User B logs in as User A ✗ (ACCOUNT TAKEOVER)
```

**Current System Defense:**
- ✅ **PROTECTED:** Email normalized consistently in all flows
- ✅ **Code:** `normalizeEmail()` in login, register, and google-oauth services
- ✅ Unique constraint on email prevents duplicates at creation time
- But: Race condition possible between lookup and create in OAuth

**Remaining Risk:** **MEDIUM** - OAuth create path lacks transaction/atomic upsert

```javascript
// google-oauth.service.ts line ~125
let user = await User.findOne({ email });  // T1: Check
// (race condition window here)
if (!user) {
  user = await User.create({ email, ... });  // T2: Create (can fail if another request wins race)
}
```

**Exploit:** Concurrent OAuth requests with same email could create multiple accounts or cause confusion.

---

### Threat 2.3.2: Session Audit Trail Gaps

**Vulnerability:** Sessions record userAgent + ipAddress but no action audit log.

**Impact:**
- Cannot prove which user made which API call
- No replay of session origin info
- Compliance audit trail incomplete

**Current System:** No action log in `logoutService`, `refreshService`, etc.

**Remaining Risk:** **MEDIUM** - Logging limitation, not crypto, but compliance issue.

---

## 2.4 Information Disclosure (Can unauthorized users access protected data?)

### Threat 2.4.1: Admin Role Stale After Downgrade

**Scenario:** Admin user's role changed from "admin" to "user" in DB, but they hold old access token with cached role.

**Attack:**
```javascript
// T=1: Admin logs in, gets token
accessToken = { sub: "admin_user_id", role: "admin", exp: T+15min }

// T=2: Admin is demoted by root
await User.updateOne({ _id: "admin_user_id" }, { role: "user" })

// T=3: (within 15 min) Admin accesses data via stale token
GET /admin/users with stale accessToken
→ Middleware checks token role: "admin" ✓
→ BUT: Token now stale!
```

**Current System Defense:**
- ✅ **PROTECTED (Socket):** Socket middleware validates role via internal bridge
- ✅ **Code:** `apps/socket/server/socket/middleware/auth.ts` calls `authorizeSocketIdentity()`
- ✅ **PROTECTED (Web Admin):** `hasActiveAdminRole()` revalidates against DB
- ✅ **Code:** `apps/web/middleware.ts` line ~45
  ```typescript
  const isAdmin = await hasActiveAdminRole(req, token.sub);
  ```

**Attack Surface:** Generic API endpoints that trust token role without revalidation?

**Remaining Risk:** **LOW** - Covered by internal bridge validation for critical paths (socket) and admin gates.

---

### Threat 2.4.2: Password Reset / Email Hijacking

**Scenario:** Attacker changes user's email via social engineering, intercepts password reset.

**Not addressed by current system** (out of scope for JWT audit, but note for full security review).

---

## 2.5 Denial of Service (Can auth flows be abused?)

### Threat 2.5.1: Refresh Token Exhaustion

**Scenario:** Attacker continuously calls `/auth/refresh` with valid token to spam DB.

**Attack:**
```javascript
// Attacker rapidly calls refresh
for (let i = 0; i < 1000; i++) {
  fetch("/auth/refresh", { method: "POST", body: refreshToken })
}
// Each call:
// - Rotates session token hash in DB (write)
// - Reads user status from DB (read)
// - Generates JWT (crypto)
// - All within same second possible
```

**System Defense:**
- ⚠️ **PARTIALLY PROTECTED:** No rate limiting in current code
- ✅ Each refresh rotates token hash (prevents *silent* replay)
- ✅ Legitimate refresh rate ~1-3 per hour (session rotation)

**Remaining Risk:** **MEDIUM** - No rate limiting on `/auth/refresh`. Should implement:
- 5 per minute per user
- 10 per minute per IP
- Back-off on repeated failures

---

### Threat 2.5.2: Logout-All Session Bombing

**Scenario:** Attacker calls logout-all-devices repeatedly to cause session churn.

**Attack:**
```javascript
const refreshToken = stolenToken;
for (let i = 0; i < 100; i++) {
  fetch("/auth/logout", { 
    method: "POST",
    body: JSON.stringify({ logoutFromAllDevices: true, refreshToken })
  })
}
```

**System Defense:**
- ✅ Logout revalidates session before deletion
- ⚠️ **NO RATE LIMITING** - Can retry indefinitely

**Remaining Risk:** **MEDIUM** - Rate limiting needed.

---

### Threat 2.5.3: Register Account Spam

**Scenario:** Attacker registers 10k accounts to exhaust storage/resources.

**Not crypto-related** but worth noting: implement CAPTCHA or phone verification.

---

## 2.6 Elevation of Privilege (Can roles be escalated?)

### Threat 2.6.1: Direct Role Claim Injection

**Scenario:** Attacker tries to set `role: "admin"` in JWT payload.

```javascript
// Attacker forges token
const forged = jwt.sign(
  { sub: "user_123", role: "admin", type: "access" },
  "wrong_secret"
);
```

**System Defense:**
- ✅ Signature verification prevents tampering
- ✅ Cannot forge without ACCESS_TOKEN_SECRET

---

### Threat 2.6.2: Refresh Token with Admin Role

**Scenario:** Can attacker use a refresh token to elevate to admin?

```javascript
// Refresh service reads role from fresh DB lookup
const user = await User.findById(payload.sub);
// Issues token with current role from DB
const accessToken = generateAccessToken({
  sub: user._id.toString(),
  role: user.role || "user",
  type: "access",
});
```

**System Defense:**
- ✅ Role always read from DB, never from token claims
- ✅ User status must be "active" before issuance
- ✅ Cannot elevate without DB update (which only admin can do)

---

### Threat 2.6.3: Session Binding Bypass

**Scenario:** Attacker tries to use another user's session ID.

```javascript
// Token has sessionId: "victim_session_id"
// But token signed with attacker's secret? NO.
// Token signed with shared secret, but...
// verifySession checks: session.userId === token.sub
// Different session bound to different user
// ✅ REJECTED
```

**System Defense:**
- ✅ Session binds user to token (userId check)
- ✅ **Code:** `if (String(session.userId) !== payload.sub)` in `verify-session.ts`

---

# PART 3: INVARIANT BREAK ANALYSIS

## Critical Invariants

### Invariant 1: "Only Active Users Can Get Tokens"

**Definition:** No user with `status != "active"` shall receive an access or refresh token (except OTP flow).

**Enforcement Points:**
1. **Login Flow** (✅ PROTECTED)
   ```typescript
   if (user.status && user.status !== "active") {
     throw new Error("Account is not active");
   }
   ```

2. **OAuth Flow** (✅ PROTECTED)
   ```typescript
   // loginWithGoogleCode: Creates users with status: "active"
   // Does NOT revalidate if existing user is banned
   ```
   ⚠️ **MINOR GAP:** If existing user is banned, OAuth doesn't recheck status

3. **Refresh Flow** (✅ PROTECTED)
   ```typescript
   if (user.status && user.status !== "active") {
     throw new Error("Account is not active");
   }
   ```

**Invariant Holds:** ✅ STRONG - Three-layer protection at login, OAuth, and refresh.

---

### Invariant 2: "Sessions Can Only Be Used By Their Owner"

**Definition:** Token from session S can only refresh if token.sub === session.userId.

**Enforcement:**
```typescript
// verify-session.ts
if (String(session.userId) !== payload.sub) {
  throw new Error("Invalid session user binding");
}
```

**Invariant Holds:** ✅ STRONG - Binding checked before every refresh/logout.

---

### Invariant 3: "Token Hash Rotates on Every Refresh"

**Definition:** After refresh, old token hash is invalidated; new token has new hash.

**Enforcement:**
```typescript
// refreshService calls rotateSessionTokenHash
await rotateSessionTokenHash(
  payload.sessionId,
  hashToken(nextRefreshToken)
);
```

**Invariant Holds:** ✅ STRONG - Rotation prevents replay.

---

### Invariant 4: "Logout Immediately Invalidates All Sessions"

**Definition:** After logout-all-devices call, no old refresh token can be used.

**Enforcement:**
```typescript
// logoutService
if (logoutFromAllDevices) {
  await deleteUserSessions(payload.sub);
}
```

**Invariant Holds:** ✅ STRONG - Immediate deletion.

---

### Invariant 5: "Token Claims Are Validated Before Use"

**Definition:** All token claims (type, sub, sessionId, role, exp) validated before processing.

**Enforcement:**
```typescript
// verifyAccessToken
if (!payload || payload.type !== "access" || typeof payload.sub !== "string") {
  throw new Error("Invalid access token payload");
}
if (payload.role && !VALID_ROLES.has(payload.role)) {
  throw new Error("Invalid access token role");
}
```

**Invariant Holds:** ✅ STRONG - Strict validation in both HTTP and Socket.

---

### Invariant 6: "Admin Role Validated on Every Admin Request"

**Definition:** Admin status must be verified from DB on every admin-gated request, not token alone.

**Enforcement (Web Middleware):**
```typescript
if (pathname.startsWith("/admin")) {
  const isAdmin = await hasActiveAdminRole(req, token.sub);
  if (!isAdmin) return NextResponse.redirect(new URL("/", req.url));
}
```

**Enforcement (Socket Middleware):**
```typescript
const authz = await authorizeSocketIdentity({ userId: payload.sub });
socket.data.isAdmin = authz.role === "admin";
```

**Invariant Holds:** ✅ STRONG - DB-backed on every check.

---

### Invariant 7: "All Layers Enforce Same Auth Rules"

**Definition:** HTTP middleware, Socket middleware, and internal API enforce identical checks.

**Cross-Layer Audit:**

| Check | HTTP | Socket | Internal API |
|-------|------|--------|--------------|
| Token signature HS256 | ✅ | ✅ | ✅ |
| Type claim ("access" or "refresh") | ✅ | ✅ | N/A |
| Sub claim present | ✅ | ✅ | N/A |
| Role enum validation | ✅ | ✅ | ✅ |
| User exists in DB | ⚠️ (optional) | ✅ | ✅ |
| User status === "active" | ⚠️ (admin only) | ✅ | ✅ |
| Admin role revalidated | ✅ | ✅ | ✅ |

**Gap Analysis:**

- **HTTP API layer**: No generic user status check. Relies on token expiry (15 min) + specific admin gate.
- **Socket Authorization**: Always revalidates user status.
- **Result**: Banned user can use stale access token for 15 minutes in HTTP API.

**Invariant Partially Violated:** ⚠️ HTTP API lacks universal user validation.

---

## Summary: Invariant Violations

| Invariant | Status | Impact | Fix Priority |
|-----------|--------|--------|--------------|
| Only active users get tokens | ✅ HELD | N/A | |
| Sessions bind to owner | ✅ HELD | N/A | |
| Token hash rotates | ✅ HELD | N/A | |
| Logout invalidates all | ✅ HELD | N/A | |
| Token claims validated | ✅ HELD | N/A | |
| Admin role always from DB | ✅ HELD | N/A | |
| **All layers enforce same rules** | ⚠️ **PARTIAL** | Banned user acts 15 min | **HIGH** |

---

# PART 4: CROSS-LAYER CONSISTENCY

## Comparison Matrix: HTTP vs Socket vs Internal API

### Layer 1: HTTP API (Next.js API Routes)

**Auth Entry:** Access token from cookie  
**Verification:**
```typescript
// No blanket auth middleware
// Each endpoint responsible for verification
// Generic pattern:
const token = req.headers.cookie?.accessToken;
// Verify signature (if checked)
// Extract claims
// Trust token (no DB revalidation)
```

**Issues:**
- ❌ No universal auth middleware
- ❌ No blanket user status check
- ⚠️ Each endpoint could verify differently

---

### Layer 2: Socket.io (Real-Time)

**Auth Entry:** Access token from handshake  
**Verification:**
```typescript
// Middleware in apps/socket/server/socket/middleware/auth.ts
const payload = verifyAccessToken(token);
const authz = await authorizeSocketIdentity({ userId: payload.sub });

if (!authz.allowed) return next(new Error("Unauthorized"));
socket.data.userId = payload.sub;
socket.data.isAdmin = authz.role === "admin";
```

**Strengths:**
- ✅ Centralized auth middleware
- ✅ DB-backed user validation (via internal bridge)
- ✅ Role always from DB, never token

---

### Layer 3: Next.js Middleware (Page Authorization)

**Auth Entry:** Access token from cookie  
**Verification:**
```typescript
// For pages
if (pathname.startsWith("/admin")) {
  const isAdmin = await hasActiveAdminRole(req, token.sub);
  if (!isAdmin) return NextResponse.redirect(new URL("/", req.url));
}
```

**Strengths:**
- ✅ DB-backed admin role check
- ✅ No-store cache (always fresh)
- ✅ Fail-closed (redirect if not admin)

---

### Layer 4: Internal API (Cross-Layer Bridge)

**Auth Entry:** INTERNAL_SECRET header  
**Verification:**
```typescript
// /api/internal/socket/authorize-identity
const providedSecret = req.headers.get(INTERNAL_SECRET_HEADER);
if (!hasValidInternalSecret(providedSecret, getInternalSecret())) {
  return deny("unauthorized_internal_request", 401);
}
```

**Strengths:**
- ✅ Constant-time secret comparison
- ✅ DB user lookup + status check
- ✅ Returns authoritative user state

---

## Consistency Gaps

### Gap 1: HTTP API Lacks Blanket User Validation

**Mismatch:**
- **Socket:** Always validates user status before accepting connection
- **HTTP:** Shared auth resolution now enforces DB-backed active-user checks
- **Impact:** Reduced substantially for routes using shared auth resolution

**Why?**
- Socket has centralized middleware (all sockets pass through)
- HTTP API routes are distributed, no universal middleware

**Attack Surface:**
```javascript
// User gets access token at T=1
const token = await login();

// Admin bans user at T=2
await User.updateOne({ _id: user._id }, { status: "banned" });

// At T=3 (within 15 min), banned user calls HTTP API
GET /api/profile with token
→ No blanket check in HTTP layer
→ Request succeeds ✗

// But Socket connection attempt:
socket.connect()
→ socketAuth middleware validates
→ User banned, rejected ✓
```

**Status (March 23, 2026):** Mitigated for protected API routes using shared auth resolution.
Residual risk remains for any endpoint that bypasses shared auth helpers.

**Recommendation:** Complete defense-in-depth by adding a universal API auth guard for all protected routes.

---

### Gap 2: Admin Role Checked Differently in Middleware vs API Routes

**Mismatch:**
- **Middleware:** Revalidates admin role on every request via internal bridge
- **Admin API routes:** May trust token role or skip check
- **Impact:** Inconsistent enforcement

**Why?**
- Middleware is centralized in `apps/web/middleware.ts`
- Individual API routes could bypass checks

**Recommendation:** Ensure POST /admin/* routes also revalidate role (or inherit middleware check).

---

### Gap 3: Socket Role Assignment After Authz

**Current Flow:**
```typescript
const authz = await authorizeSocketIdentity({ userId });
socket.data.isAdmin = authz.role === "admin";
```

**Potential Issue:** Role set once at connection. If user demoted while connected:
- Socket still has `isAdmin = true`
- User can emit events as admin
- No re-check on each event

**Why This Is Acceptable:**
- Short-lived connections (browser tab, typical <1 hour)
- Admin actions typically rare
- Role demote is rare
- Socket.io events are triggered by client; server-side checks still apply

**Recommendation:** If critical, add per-event role revalidation for admin actions.

---

### Gap 4: Email Normalization Inconsistency

**Current:**
```typescript
// login.service.ts
const user = await User.findOne({ email: normalizeEmail(email) });

// register.service.ts
const normalizedEmail = normalizeEmail(email);
const existing = await User.findOne({ email: normalizedEmail });

// google-oauth.service.ts
const email = normalizeEmail(profile.email);
let user = await User.findOne({ email });
```

**Good:** Consistency applied across all flows.  
**Concern:** Race condition in OAuth (check, then create) not atomic.

---

## Cross-Layer Recommendation

**Implement unified auth function:**
```typescript
// Shared across HTTP, Socket, Middleware
async function validateUserIsActive(userId: string): Promise<boolean> {
  const user = await User.findById(userId)
    .select("_id status")
    .lean();
  return user && (!user.status || user.status === "active");
}
```

**Usage in HTTP layer:**
```typescript
// middleware.ts or per-route
const isActive = await validateUserIsActive(token.sub);
if (!isActive) return NextResponse.redirect(new URL("/login", req.url));
```

---

# PART 5: ATTACK SCENARIOS

## Attack 1: Refresh Token Compromise & Persistent Access

**Scenario:** Attacker obtains refresh token via XSS or packet sniffing.

**Preconditions:**
- Attacker can sniff HTTPS (e.g., corporate MITM proxy) OR user falls for phishing
- Refresh token stored in HTTP-only cookie → harder but possible with XSS

**Attack Steps:**

```
T=0: User logs in normally
     - Gets accessToken + refreshToken
     - refreshToken stored in cookie

T=1: Attacker intercepts refreshToken (e.g., XSS exfiltrates cookie)
     - stolenToken = "eyJ..."

T=2: Legitimate user continues using app
     - At T=2, session has hash("refreshToken_A")

T=3a: Attacker uses stolenToken to refresh
      POST /auth/refresh with stolenToken
      → Server finds session
      → Verifies hash(stolenToken) matches DB ✓ (still valid at this moment)
      → Issues NEW accessToken + refreshToken_B
      → Rotates DB session hash to hash("refreshToken_B")

      Now attacker has:
      - New accessToken (15 min) → Can access API
      - NewRefreshToken_B → Can get more tokens
      - Legitimate user also has refreshToken_A (old) → STALE

T=3b: Legitimate user tries to refresh with their old token
      POST /auth/refresh with refreshToken_A
      → Server finds session
      → Verifies hash(refreshToken_A) matches DB hash hash("refreshToken_B")
      → MISMATCH ✗
      → Rejected: "Invalid session token"
      → Legitimate user logged out unexpectedly!

T=4: Attacker continues refreshing with stolenToken_B
     POST /auth/refresh with stolenToken_B
     → Issues NEW accessToken + refreshToken_C
     → Rotates DB hash to hash("refreshToken_C")
     → Attacker remains logged in

... (attacker can refresh indefinitely)

T=N (when refreshToken_B expires in 7 days):
     Attacker tries to refresh with refreshToken_B (now expired)
     → jwt.verify fails (exp check)
     → Attacker logged out
```

**System Response:**

- ✅ **Detected:** Legitimate user sees logout (hash mismatch)
  - User should change password immediately
  - Clear all sessions (admin action)

- ✅ **Contained:** Refresh token rotation ensures attacker can't reuse old tokens
  - Each refresh invalidates previous token

- ⚠️ **Window:** Attacker can act during the 7-day refresh TTL
  - Shorter TTL (24h) would help but impact UX (re-login needed)

**Mitigation:**
1. **Immediate:** Implement device fingerprinting to detect mismatched IP/UserAgent
2. **Immediate:** Implement refresh rate limiting (5/minute)
3. **Short-term:** Add refresh token version counter for early rotation
4. **Long-term:** Implement mutual TLS for internal API calls (network layer defense)

---

## Attack 2: Banned User Persistence via Stale Access Token

**Scenario:** Admin bans user; user remains active in HTTP API for 15 minutes.

**Preconditions:**
- User has valid access token
- Admin bans the user
- User attempts API call before token expiry

**Attack Steps:**

```
T=0: User logs in
     - Gets accessToken { sub: "user_123", role: "user", exp: T+15min }

T=7min: Admin bans the user
        User.updateOne({ _id: "user_123" }, { status: "banned" })

T=10min: Banned user tries to call API
         GET /api/messages with stale accessToken
         
         Current HTTP layer:
         - Verifies JWT signature ✓
         - Extracts { sub: "user_123", role: "user" }
         - NO DB revalidation
         - Request SUCCEEDS ✗

         Meanwhile, if user tries Socket:
         socket.connect()
         → socketAuth middleware calls authorizeSocketIdentity
         → Lookup user in DB
         → Check status === "active"
         → User is BANNED → REJECTED ✓

T+15min: Access token expires
         - Socket was already rejected (T+10min)
         - HTTP API finally rejects (token now stale)
         - Banned user cannot get new tokens (refreshService checks status)
```

**System Response:**

- ✅ **Protected (Socket):** Banned immediately
- ⚠️ **Vulnerable (HTTP):** 15-minute window
- ✅ **Protected (Refresh):** Cannot get new tokens
- ✅ **Protected (Long-term):** User eventually locked out

**Impact:**
- Moderate: Reading data only, unlikely to modify system
- High: If API includes write operations (send messages, change profile)
- Critical: If API includes admin actions

**Mitigation:**
1. **Immediate:** Add HTTP auth middleware with user status check
   ```typescript
   // middleware.ts
   const isActive = await User.findById(token.sub).select("status");
   if (isActive.status !== "active") {
     return NextResponse.redirect(new URL("/login", req.url));
   }
   ```

2. **Cache considerations:** Cache user status for 1-2 minutes to avoid DB overload
   - Redis: `user:status:user_123` → cache for 60 sec
   - On ban, invalidate cache immediately

---

## Attack 3: OAuth Account Takeover via Email Race Condition

**Scenario:** Two users register with same email (one via password, one via OAuth); race condition causes confusion.

**Preconditions:**
- Email validation is case-insensitive (currently normalized)
- User A registers via password
- User B tries to login via OAuth with SAME email

**Attack Steps:**

```
T=0: User A registers with password
     POST /auth/register { email: "alice@example.com", password: "pwd_A" }
     → Normalizes to "alice@example.com"
     → Checks unique: User.findOne({ email: "alice@example.com" }) → null
     → Creates user { _id: "obj_A", email: "alice@example.com", password: hash_A }

T=1: Attacker learns User A's email (social engineering, public profile, etc.)

T=2: Attacker initiates Google OAuth with their own Google account
     Click "Login with Google"
     → Redirect to Google consent
     → Attacker's Google account authenticated
     → Google returns profile { email: "alice@example.com", sub: "google_id_xyz" }
     
     Wait, this only works if Attacker controls the Google account with that email.
     More realistic: Attacker uses their legitimate Google account,
     tries to claim alice@example.com as their email... Google won't let that happen.
     
     REVISED ATTACK:
     Attacker has Google account with email: "alice@example.com"
     (perhaps via Gmail account takeover or legitimate typosquatting)

T=3: Attacker logs in via Google
     POST /auth/oauth/google/callback { code: "..." }
     → Exchanges code for Google profile
     → Profile: { email: "alice@example.com", name: "Attacker Name" }
     → Normalizes email to "alice@example.com"
     → Calls: let user = await User.findOne({ email: "alice@example.com" })
     → FOUND! user == obj_A (User A)
     → Issue token for User A ✗
     → Attacker now logged in as User A

Result: Attacker gains access to User A's account
```

**System Response:**

- ⚠️ **VULNERABLE:** OAuth create is not atomic with check
  ```typescript
  // google-oauth.service.ts line ~125
  let user = await User.findOne({ email });  // ← Race window
  if (!user) {
    user = await User.create({ email, ... });  // ← Another request could create here
  }
  ```

- ⚠️ **VULNERABLE:** No password reset after OAuth login
  - Attacker is now logged in, can change password
  - Original user permanently locked out

**Impact:** CRITICAL - Complete account takeover

**Mitigation:**

1. **Immediate:** Use Mongoose session + transaction
   ```typescript
   const session = await mongoose.startSession();
   session.startTransaction();
   
   try {
     let user = await User.findOne({ email }).session(session);
     if (!user) {
       user = await User.create([{ email, ... }], { session });
     } else if (user.status === "banned") {
       throw new Error("User banned - cannot login");
     }
     
     await session.commitTransaction();
   } catch (e) {
     await session.abortTransaction();
     throw e;
   }
   ```

2. **Immediate:** Check user status in OAuth flow
   ```typescript
   if (user.status && user.status !== "active") {
     throw new Error("User account is not active");
   }
   ```

3. **Better:** Separate OAuth-first login from password-first login
   - Store OAuth provider + provider ID on user
   - On first OAuth, require email verification
   - Prevent linking OAuth to password account without user consent

---

## Attack 4: Logout-All DoS (Denial of Service)

**Scenario:** Attacker repeatedly calls logout-all-devices to disrupt legitimate users.

**Preconditions:**
- Attacker has user's refresh token (via phishing or compromise)
- No rate limiting on logout endpoint

**Attack Steps:**

```
T=0: Attacker obtains refresh token
     (via phishing email, network compromise, etc.)

T=1: Attacker calls logout endpoint repeatedly
     for (i = 0; i < 1000; i++) {
       POST /auth/logout {
         refreshToken: stolenToken,
         logoutFromAllDevices: true
       }
     }
     
     First few calls:
     1. Call 1: verifySession(stolenToken) ✓ → Deletes all sessions ✓
     2. Call 2: verifySession(stolenToken) ✗ → "Invalid session"
     3. Calls 3-1000: All fail with "Invalid session"
     
Result: Legitimate user's sessions destroyed once, then further calls fail.
        User is logged out and forced to login again.
```

**System Response:**

- ✅ **Protected (Single logout):** Works once, then fails
- ⚠️ **Vulnerable (None):** No rate limiting
- ⚠️ **Vulnerable (UX):** User must re-login on all devices

**Impact:** Medium - DoS (forced logout), not account compromise

**Mitigation:**

1. **Immediate:** Implement rate limiting
   ```typescript
   // Rate limit: 5 logouts per 5 minutes per user
   const logoutCount = await redis.incr(`logout:${payload.sub}`);
   if (logoutCount > 5) {
     return deny("logout_rate_limit_exceeded", 429);
   }
   await redis.expire(`logout:${payload.sub}`, 300);
   ```

2. **Immediate:** Implement exponential backoff
   ```typescript
   const failedAttempts = await redis.incr(`logout_fails:${payload.sub}`);
   const waitTime = Math.pow(2, failedAttempts - 1) * 1000; // 1s, 2s, 4s...
   ```

3. **Better:** Send audit log when logout-all triggered
   ```typescript
   await auditLog.create({
     user_id: payload.sub,
     action: "logout_all_devices",
     ip: req.ip,
     timestamp: new Date(),
   });
   ```

   Monitor for repeated logout-all events → alert user

---

## Attack 5: Token Type Confusion (if validation missing)

**Scenario:** Attacker uses refresh token where access token expected.

**Preconditions:**
- System doesn't validate token type claim

**Attack Steps:**

```
T=0: User logs in
     - Gets accessToken { type: "access", sub: "user_123", exp: T+15m }
     - Gets refreshToken { type: "refresh", sub: "user_123", sessionId: "...", exp: T+7d }

T=1: Attacker intercepts BOTH tokens (compromise)

T=8min: AccessToken still valid for 7 more minutes
        But attacker wants to use refreshToken as accessToken

        If system doesn't check type:
        GET /api/profile with refreshToken
        → Verify signature ✓
        → Extract payload { type: "refresh", sub: "user_123", ... }
        → No type check ✗
        → Middleware accepts it as access token ✗

        Result: refreshToken (7d TTL) can be used as access token
                API calls don't require fresh access token
                Attacker can impersonate user for 7 days, not 15 minutes

Current system defense:
```

**System Response:**

- ✅ **PROTECTED:** Type validation enforced
  ```typescript
  // verify.ts
  if (payload.type !== "access") {
    throw new Error("Invalid access token payload");
  }
  ```

- ✅ **PROTECTED:** Both verifyAccessToken and middleware check type

**Impact:** Prevented - Not exploitable.

---

## Attack 6: Session Binding Bypass (Concurrent Sessions)

**Scenario:** Attacker logs in with same user account on multiple devices simultaneously; tries to use one device's session from another.

**Preconditions:**
- User logs in on device A and device B
- Each creates separate session record in DB
- Attacker compromises device A's refresh token

**Attack Steps:**

```
T=0: User logs in on Device A
     Creates Session_A { _id: "sess_a", userId: "user_123", tokenHash: hash_a }
     Device A has: refreshToken_A with sessionId: "sess_a"

T=1: User logs in on Device B
     Creates Session_B { _id: "sess_b", userId: "user_123", tokenHash: hash_b }
     Device B has: refreshToken_B with sessionId: "sess_b"

T=2: Attacker compromises Device A, steals refreshToken_A

T=3: Attacker tries to impersonate by using refreshToken_A from elsewhere
     POST /auth/refresh with refreshToken_A
     
     Payload: { sub: "user_123", sessionId: "sess_a", type: "refresh" }
     
     verifySession:
     - Find session by sessionId: sess_a
     - Check session.userId === token.sub: "user_123" === "user_123" ✓ ✓
     - Hash validation passes (attacker has the token)
     - Session returned for refresh
     - New tokens issued

Result: Yes, attacker can refresh using Device A's session from anywhere
```

**System Response:**

- ✅ **Protected (Binding):** Session checks user binding
- ⚠️ **Vulnerability:** Session binding doesn't include device fingerprint/IP
  - Only checks userId, not device identity

**Mitigation:**

1. **Current:** Device tracked via userAgent + ipAddress (logged in session)
2. **Stronger:** On refresh, validate userAgent/IP haven't changed dramatically
   ```typescript
   if (session.ipAddress !== req.ip && !isWithinExpectedRange(req.ip, session.ipAddress)) {
     // Could be compromise or legitimate travel
     // Option 1: Require MFA
     // Option 2: Send verification email
     // Option 3: Require re-login
   }
   ```

3. **Even stronger:** Require MFA refresh on every new IP

**Impact:** Moderate - Session theft still exploitable, but fingerprinting helps.

---

# PART 6: HARDENED DESIGN

## 6.1 Current State Assessment

**Strengths:**
- ✅ HS256-only JWT verification (no algorithm substitution)
- ✅ Scoped config getters (no env access at startup)
- ✅ Token hash rotation on refresh (prevents replay)
- ✅ Session binding to user (prevents hijacking)
- ✅ Admin role revalidated on every request via internal bridge
- ✅ Token type claims validated
- ✅ Email normalization consistent

**Weaknesses:**
- ⚠️ No universal API auth guard yet (defense-in-depth gap for routes bypassing shared helpers)
- ⚠️ Rate limiting is currently in-memory (per-instance, not globally coordinated)
- ⚠️ OAuth identity linking policy is still email-based and should be provider-aware for stronger anti-takeover posture
- ⚠️ No device fingerprinting / IP tracking in refresh
- ⚠️ No audit logging for auth events
- ⚠️ Long refresh TTL (7 days) gives wide compromise window

---

## 6.2 Proposed Hardened Architecture

### Architecture Principle 1: DB is Always Source of Truth

**Rule:** Never trust cached token claims for:
- User existence
- User status (active/banned)
- User role (for privileged operations)

**Implementation:**

```typescript
// Instead of:
GET /admin/users with accessToken
→ Check token.role === "admin"
→ Serve data

// Must do:
GET /admin/users with accessToken
→ Check token signature
→ Extract token.sub
→ Query DB: User.findById(token.sub).select("role status")
→ Verify user.status === "active" && user.role === "admin"
→ Then serve data
```

---

### Architecture Principle 2: Each Layer Enforces Independently

**Layer 1: JWT Verification**
- Signature validation (HS256)
- Claim shape validation (type, sub, sessionId)
- Expiry check
- Algorithm restriction

**Layer 2: Session Validation**
- DB session exists
- Token hash matches
- Session not revoked
- User binding correct

**Layer 3: Business Logic Validation**
- User exists in DB
- User status check
- User role check
- Resource-specific authorization

**Code Example:**
```typescript
// Correct: All 3 layers
async function protectedEndpoint(req: Request) {
  // Layer 1: JWT verification
  const token = req.headers.get("authorization")?.split(" ")[1];
  const payload = verifyAccessToken(token); // Throws on invalid signature
  
  // Layer 2: (Optional, for refresh flows)
  // const { session } = await verifySession(refreshToken);
  
  // Layer 3: Business logic
  const user = await User.findById(payload.sub)
    .select("_id status role")
    .lean();
  
  if (!user || user.status !== "active") {
    throw new Error("Unauthorized");
  }
  
  if (user.role !== "admin") {
    throw new Error("Forbidden");
  }
  
  // Now safe to proceed
  return doAdminTask();
}
```

---

### Architecture Principle 3: Consistent Auth Middleware Across All Layers

**Current Gap:** HTTP doesn't have blanket check; Socket does.

**Proposed:**
```typescript
// Shared middleware
async function authenticationMiddleware(userId: string, requiredRole?: string) {
  // Always validate user exists
  const user = await User.findById(userId)
    .select("_id status role")
    .lean();
  
  if (!user) {
    throw new Error("User not found");
  }
  
  if (user.status !== "active") {
    throw new Error("User not active");
  }
  
  if (requiredRole && user.role !== requiredRole) {
    throw new Error("Forbidden");
  }
  
  return user;
}

// Usage in HTTP route
export async function GET(req: Request) {
  const token = verifyAccessToken(req.headers.get("authorization"));
  const user = await authenticationMiddleware(token.sub);
  return Response.json({ data: user });
}

// Usage in Socket event
socket.on("chat:send", async (message) => {
  const user = await authenticationMiddleware(socket.data.userId);
  // Process message as user
});
```

---

### Architecture Principle 4: Rate Limiting on Auth Endpoints

**Current:** No rate limiting.

**Proposed:**
```typescript
// /auth/refresh
// Rate limit: 5 per minute per user, 20 per minute per IP
const refreshLimiter = rateLimit({
  keyGenerator: (req) => {
    // Use user ID if authenticated, IP otherwise
    return req.user?.id || req.ip;
  },
  skip: (req) => !req.user, // Skip if no user context
  windowMs: 60 * 1000,
  max: (req) => req.user ? 5 : 20,
  message: "Too many refresh attempts",
});

// /auth/logout
// Rate limit: 3 per minute per user
const logoutLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 3,
});

// /auth/register
// Rate limit: 5 per 10 minutes per IP (prevent spam)
const registerLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  skip: (req) => req.user, // Skip if already logged in
});
```

---

### Architecture Principle 5: Atomic OAuth Upsert

**Current:** Check, then create (race condition).

**Proposed:**
```typescript
// Use Mongoose transaction
export async function loginWithGoogleCode({
  code,
  redirectUri,
  userAgent,
  ipAddress,
}: LoginWithGoogleCodeInput) {
  const tokens = await exchangeGoogleCodeForTokens({ code, redirectUri });
  const profile = await fetchGoogleUserProfile(tokens.access_token);

  if (!profile.email || !profile.email_verified) {
    throw new Error("Google account email is missing or unverified");
  }

  const email = normalizeEmail(profile.email);
  
  // Start transaction
  const session = await mongoose.startSession();
  session.startTransaction();
  
  try {
    // Atomic find-or-create
    let user = await User.findOne({ email }).session(session);
    
    if (!user) {
      // Create new user
      user = await User.create(
        [{
          username: profile.name || email.split("@")[0],
          email,
          password: "",
          profilePicture: profile.picture,
          role: "user",
          status: "active",
          isVerified: new Date(),
          isOnline: false,
          conversations: [],
        }],
        { session }
      ).then((docs) => docs[0]);
    } else {
      // Existing user - MUST be active
      if (user.status && user.status !== "active") {
        throw new Error("Account is not active");
      }
      
      // Update profile picture if not set
      if (!user.profilePicture && profile.picture) {
        user.profilePicture = profile.picture;
        await user.save({ session });
      }
    }
    
    await session.commitTransaction();
    
    // Continue with token issuance...
    const accessToken = generateAccessToken({
      sub: user._id.toString(),
      role: user.role,
      type: "access",
    });
    
    // ... 
  } catch (e) {
    await session.abortTransaction();
    throw e;
  } finally {
    await session.endSession();
  }
}
```

---

### Architecture Principle 6: Device Fingerprinting on Refresh

**Current:** No device tracking.

**Proposed:**
```typescript
async function refreshService(refreshToken: string, context: RefreshContext) {
  const { payload } = await verifySession(refreshToken);
  
  // ... existing validation ...
  
  const session = await findSessionByIdWithToken(payload.sessionId);
  
  // NEW: Device fingerprint check
  const fingerprint = computeDeviceFingerprint({
    userAgent: context.userAgent,
    ipAddress: context.ipAddress,
  });
  
  const storedFingerprint = session.deviceFingerprint;
  
  if (!areDeviceFingerprintsSimilar(fingerprint, storedFingerprint)) {
    // New device detected - could be:
    // 1. User traveling (different IP, different browser)
    // 2. Stolen token (attacker using from different network)
    
    // Option A: Require MFA
    // Option B: Send verification email
    // Option C: Continue but log suspicious activity
    
    await auditLog.create({
      userId: payload.sub,
      action: "refresh_from_new_device",
      oldFingerprint: storedFingerprint,
      newFingerprint: fingerprint,
      timestamp: new Date(),
      risk: "medium",
    });
    
    // For now, allow but log
  }
  
  // ... issue tokens ...
}

type RefreshContext = {
  userAgent: string;
  ipAddress: string;
};

function computeDeviceFingerprint(context: RefreshContext): string {
  // Extract meaningful parts
  const browserFamily = extractBrowserFamily(context.userAgent);
  const osFamily = extractOsFamily(context.userAgent);
  const ipSubnet = extractIpSubnet(context.ipAddress);
  
  return `${browserFamily}:${osFamily}:${ipSubnet}`;
}

function areDeviceFingerprintsSimilar(fp1: string, fp2: string): boolean {
  // Allow some drift
  // Same browser family + OS + same IP subnet = match
  const [browser1, os1, subnet1] = fp1.split(":");
  const [browser2, os2, subnet2] = fp2.split(":");
  
  return (
    browser1 === browser2 &&
    os1 === os2 &&
    subnet1 === subnet2
  );
}
```

---

### Architecture Principle 7: Token Versioning for Emergency Rotation

**Current:** No way to invalidate all tokens except logout-all-devices (which deletes sessions).

**Proposed:**
```typescript
// On User model, add tokenVersion field
interface IUser extends Document {
  // ...
  tokenVersion: number; // Incremented on security events
}

// On token generation
function generateAccessToken(payload: AccessTokenPayload): string {
  const config = getAccessTokenConfig();
  return jwt.sign({
    ...payload,
    tokenVersion: user.tokenVersion,
  }, config.secret, {
    expiresIn: config.expiresIn,
    algorithm: "HS256",
  });
}

// On token verification
function verifyAccessToken(token: string): AccessTokenPayload {
  const payload = jwt.verify(token, config.secret, {
    algorithms: ["HS256"],
  }) as Partial<AccessTokenPayload>;
  
  // NEW: Verify token version matches current user version
  const user = await User.findById(payload.sub)
    .select("_id tokenVersion")
    .lean();
  
  if (!user || user.tokenVersion !== payload.tokenVersion) {
    throw new Error("Token revoked"); // User invalidated all old tokens
  }
  
  return payload;
}

// On security events (password change, email update, etc.)
async function invalidateAllUserTokens(userId: string) {
  await User.updateOne(
    { _id: userId },
    { $inc: { tokenVersion: 1 } }
  );
  // All old tokens now have stale tokenVersion → rejected
  // All sessions also deleted (logout-all-devices equivalent)
}
```

---

### Architecture Principle 8: Audit Logging for All Auth Events

**Current:** No audit trail.

**Proposed:**
```typescript
// Create auditLog collection
interface AuditLog {
  _id: ObjectId;
  userId: ObjectId;
  action: string; // "login", "refresh", "logout", "logout_all", "failed_login", etc.
  success: boolean;
  reason?: string; // If failed
  ipAddress: string;
  userAgent: string;
  timestamp: Date;
  metadata?: Record<string, any>;
}

// Log on every auth event
export const loginUser = async (email: string, password: string, ipAddress: string) => {
  try {
    const user = await User.findOne({ email: normalizeEmail(email) });
    // ... validation ...
    
    await auditLog.create({
      userId: user._id,
      action: "login",
      success: true,
      ipAddress,
      userAgent: req.headers.get("user-agent"),
      timestamp: new Date(),
    });
    
    return { user, accessToken, refreshToken };
  } catch (error) {
    // Still log failed attempts
    await auditLog.create({
      userId: null, // Unknown user
      action: "login",
      success: false,
      reason: error.message,
      ipAddress,
      userAgent: req.headers.get("user-agent"),
      timestamp: new Date(),
      metadata: { email: normalizeEmail(email) },
    });
    
    throw error;
  }
};

// Admin dashboard can query suspicious patterns
// - Multiple failed logins from same IP
// - Logins from unusual locations
// - Logout-all followed by login from different IP
```

---

## 6.3 Hardened Architecture Summary Table

| Component | Current | Hardened | Impact |
|-----------|---------|----------|--------|
| JWT Algorithm | HS256 only | ✅ Same | No change needed |
| Token Hash Rotation | Per refresh | ✅ Same | No change needed |
| Session Binding | userId check | ✅ + Device fp | Medium: Better compromise detection |
| HTTP Auth Validation | Token only | **Add user status check** | High: Closes 15-min banned user window |
| Rate Limiting | None | Add 5/min refresh | Medium: DoS protection |
| OAuth Upsert | Racy | Atomic transaction | High: Eliminates race condition |
| Device Fingerprinting | None | Compute + compare | Medium: Detects token compromises |
| Token Versioning | None | Optional | Low: Emergency revocation |
| Audit Logging | None | Add all events | Medium: Compliance + forensics |
| Admin Role Check | Per request ✅ | ✅ Already done | No change |

---

# PART 7: SECURITY TEST PLAN

## Test Suite: Proof of System Safety

### Category 1: Token Validation Tests

#### Test 1.1: Algorithm Substitution Blocked
```typescript
test("rejects 'none' algorithm JWT", async () => {
  const token = jwt.sign(
    { sub: "user_123", role: "admin", type: "access" },
    "",
    { algorithm: "none" }
  );
  
  expect(() => verifyAccessToken(token))
    .toThrow("Invalid token");
});

test("rejects RS256 algorithm (should be HS256)", async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  
  const token = jwt.sign(
    { sub: "user_123", role: "admin", type: "access" },
    privateKey,
    { algorithm: "RS256" }
  );
  
  expect(() => verifyAccessToken(token))
    .toThrow("Invalid token");
});

test("accepts only HS256 algorithm", async () => {
  const token = generateAccessToken({
    sub: "user_123",
    role: "user",
    type: "access",
  });
  
  const payload = verifyAccessToken(token);
  expect(payload.sub).toBe("user_123");
});
```

---

#### Test 1.2: Token Type Validation
```typescript
test("access token rejected as refresh token", async () => {
  const accessToken = generateAccessToken({
    sub: "user_123",
    role: "user",
    type: "access",
  });
  
  expect(() => verifyRefreshToken(accessToken))
    .toThrow("Invalid refresh token payload");
});

test("refresh token rejected as access token", async () => {
  const refreshToken = generateRefreshToken({
    sub: "user_123",
    sessionId: "sess_123",
    type: "refresh",
  });
  
  expect(() => verifyAccessToken(refreshToken))
    .toThrow("Invalid access token payload");
});
```

---

#### Test 1.3: Role Enum Validation
```typescript
test("rejects invalid role enum", async () => {
  const payload = { sub: "user_123", role: "superadmin", type: "access" };
  const token = jwt.sign(payload, process.env.ACCESS_TOKEN_SECRET!);
  
  expect(() => verifyAccessToken(token))
    .toThrow("Invalid access token role");
});

test("accepts valid role enums", async () => {
  for (const role of ["user", "moderator", "admin"]) {
    const token = generateAccessToken({
      sub: "user_123",
      role: role as any,
      type: "access",
    });
    
    const payload = verifyAccessToken(token);
    expect(payload.role).toBe(role);
  }
});
```

---

### Category 2: User Status Validation Tests

#### Test 2.1: Banned User Cannot Login
```typescript
test("banned user cannot login", async () => {
  const user = await User.create({
    email: "banned@example.com",
    password: await hashPassword("pwd123"),
    status: "banned",
  });
  
  expect(() => loginUser({
    email: "banned@example.com",
    password: "pwd123",
  })).rejects.toThrow("Account is not active");
});
```

---

#### Test 2.2: Banned User Cannot Refresh
```typescript
test("banned user cannot refresh tokens", async () => {
  const user = await User.create({
    email: "active@example.com",
    password: await hashPassword("pwd123"),
    status: "active",
  });
  
  const { refreshToken } = await loginUser({
    email: "active@example.com",
    password: "pwd123",
  });
  
  // User gets banned
  await User.updateOne({ _id: user._id }, { status: "banned" });
  
  // Cannot refresh
  expect(() => refreshService(refreshToken))
    .rejects.toThrow("Account is not active");
});
```

---

#### Test 2.3: Deleted User Cannot Refresh
```typescript
test("deleted user cannot refresh tokens", async () => {
  const user = await User.create({
    email: "delete@example.com",
    password: await hashPassword("pwd123"),
  });
  
  const { refreshToken } = await loginUser({
    email: "delete@example.com",
    password: "pwd123",
  });
  
  // User deleted
  await User.deleteOne({ _id: user._id });
  
  // Cannot refresh
  expect(() => refreshService(refreshToken))
    .rejects.toThrow("User not found");
});
```

---

### Category 3: Session Management Tests

#### Test 3.1: Token Hash Prevents Replay
```typescript
test("old refresh token rejected after rotation", async () => {
  let user = await User.create({
    email: "rotate@example.com",
    password: await hashPassword("pwd123"),
  });
  
  const { refreshToken: token1, accessToken: access1 } = await loginUser({
    email: "rotate@example.com",
    password: "pwd123",
  });
  
  // First refresh (rotates token)
  const { refreshToken: token2 } = await refreshService(token1);
  
  // Old token2 is now valid (most recent)
  const { refreshToken: token3 } = await refreshService(token2);
  
  // token2 is now stale
  expect(() => refreshService(token2))
    .rejects.toThrow("Invalid session token");
});
```

---

#### Test 3.2: Session Binding Enforced
```typescript
test("session prevents cross-user token misuse", async () => {
  const user1 = await User.create({
    email: "user1@example.com",
    password: await hashPassword("pwd123"),
  });
  
  const user2 = await User.create({
    email: "user2@example.com",
    password: await hashPassword("pwd123"),
  });
  
  const { refreshToken: token1 } = await loginUser({
    email: "user1@example.com",
    password: "pwd123",
  });
  
  // Manually craft token with user2's ID but user1's session
  const sessionId = extractSessionIdFromToken(token1);
  const fakeToken = generateRefreshToken({
    sub: user2._id.toString(), // Different user
    sessionId, // User1's session
    type: "refresh",
  });
  
  // Should fail
  expect(() => refreshService(fakeToken))
    .rejects.toThrow("Invalid session user binding");
});
```

---

#### Test 3.3: Revoked Session Cannot Be Used
```typescript
test("revoked session rejects refresh", async () => {
  const user = await User.create({
    email: "revoke@example.com",
    password: await hashPassword("pwd123"),
  });
  
  const { refreshToken } = await loginUser({
    email: "revoke@example.com",
    password: "pwd123",
  });
  
  // Get session
  const session = await findSessionByIdWithToken(extractSessionIdFromToken(refreshToken));
  
  // Revoke it
  await revokeSession(session._id.toString());
  
  // Cannot refresh
  expect(() => refreshService(refreshToken))
    .rejects.toThrow("Session revoked");
});
```

---

### Category 4: Logout Tests

#### Test 4.1: Logout-All Deletes All Sessions
```typescript
test("logout all devices invalidates all refresh tokens", async () => {
  const user = await User.create({
    email: "logoutall@example.com",
    password: await hashPassword("pwd123"),
  });
  
  // Login on device 1
  const { refreshToken: token1 } = await loginUser({
    email: "logoutall@example.com",
    password: "pwd123",
  });
  
  // Login on device 2
  const { refreshToken: token2 } = await loginUser({
    email: "logoutall@example.com",
    password: "pwd123",
  });
  
  // Logout all
  await logoutService({
    refreshToken: token1,
    logoutFromAllDevices: true,
  });
  
  // Both tokens should fail
  expect(() => refreshService(token1))
    .rejects.toThrow("Invalid session");
  
  expect(() => refreshService(token2))
    .rejects.toThrow("Invalid session");
});
```

---

#### Test 4.2: Stale Token Cannot Trigger Logout-All
```typescript
test("rotated token cannot logout all devices", async () => {
  const user = await User.create({
    email: "stale@example.com",
    password: await hashPassword("pwd123"),
  });
  
  const { refreshToken: token1 } = await loginUser({
    email: "stale@example.com",
    password: "pwd123",
  });
  
  // Refresh (rotates token)
  const { refreshToken: token2 } = await refreshService(token1);
  
  // token1 is now stale
  // Attacker tries logout-all with old token
  expect(() => logoutService({
    refreshToken: token1,
    logoutFromAllDevices: true,
  })).rejects.toThrow("Invalid session token");
  
  // User can still refresh with current token
  const { refreshToken: token3 } = await refreshService(token2);
  expect(token3).toBeDefined();
});
```

---

### Category 5: Admin Role Tests

#### Test 5.1: Admin Role Validated on Each Request
```typescript
test("admin role revalidated on each middleware check", async () => {
  const admin = await User.create({
    email: "admin@example.com",
    password: await hashPassword("pwd123"),
    role: "admin",
  });
  
  const { accessToken } = await loginUser({
    email: "admin@example.com",
    password: "pwd123",
  });
  
  // First check: passes
  const isAdminBefore = await hasActiveAdminRole(req, admin._id.toString());
  expect(isAdminBefore).toBe(true);
  
  // Admin is demoted
  await User.updateOne({ _id: admin._id }, { role: "user" });
  
  // Second check: fails (revalidated from DB)
  const isAdminAfter = await hasActiveAdminRole(req, admin._id.toString());
  expect(isAdminAfter).toBe(false);
});
```

---

#### Test 5.2: Non-Admin Cannot Claim Admin (Socket)
```typescript
test("socket rejects non-admin even with admin token role", async () => {
  const user = await User.create({
    email: "user@example.com",
    password: await hashPassword("pwd123"),
    role: "user",
  });
  
  const token = jwt.sign(
    { sub: user._id.toString(), role: "admin", type: "access" },
    process.env.ACCESS_TOKEN_SECRET!
  );
  
  // Socket auth should override and check DB
  const authz = await authorizeSocketIdentity({ userId: user._id.toString() });
  expect(authz.role).toBe("user");
  expect(authz.allowed).toBe(true);
});
```

---

### Category 6: Email Normalization Tests

#### Test 6.1: Email Case-Insensitivity
```typescript
test("same email with different case treated as same account", async () => {
  // Register with lowercase
  const user1 = await registerService({
    username: "testuser",
    email: "alice@example.com",
    password: "pwd123",
  });
  
  // Try to register with uppercase
  expect(() => registerService({
    username: "aliceupdate",
    email: "ALICE@EXAMPLE.COM",
    password: "pwd456",
  })).rejects.toThrow("User already exists");
});

test("login works with different case email", async () => {
  await registerService({
    username: "testuser",
    email: "alice@example.com",
    password: "pwd123",
  });
  
  // Login with uppercase
  const result = await loginUser({
    email: "ALICE@EXAMPLE.COM",
    password: "pwd123",
  });
  
  expect(result.user.email).toBe("alice@example.com");
});
```

---

### Category 7: Cross-Layer Consistency Tests

#### Test 7.1: HTTP and Socket Reject Same User
```typescript
test("users rejected in both HTTP and Socket after ban", async () => {
  const user = await User.create({
    email: "ban@example.com",
    password: await hashPassword("pwd123"),
    status: "active",
  });
  
  const { accessToken } = await loginUser({
    email: "ban@example.com",
    password: "pwd123",
  });
  
  // Ban the user
  await User.updateOne({ _id: user._id }, { status: "banned" });
  
  // Both layers should reject
  
  // Socket:
  const socketAuthz = await authorizeSocketIdentity({ userId: user._id.toString() });
  expect(socketAuthz.allowed).toBe(false);
  
  // HTTP (admin gate):
  const isAdmin = await hasActiveAdminRole(req, user._id.toString());
  expect(isAdmin).toBe(false);
});
```

---

#### Test 7.2: Role Changes Reflected Everywhere
```typescript
test("role changes immediately visible in all layers", async () => {
  const user = await User.create({
    email: "rolechange@example.com",
    password: await hashPassword("pwd123"),
    role: "user",
  });
  
  // Promote to admin
  await User.updateOne({ _id: user._id }, { role: "admin" });
  
  // Socket layer sees new role
  const socketAuthz = await authorizeSocketIdentity({ userId: user._id.toString() });
  expect(socketAuthz.role).toBe("admin");
  
  // Middleware sees new role
  const isAdmin = await hasActiveAdminRole(req, user._id.toString());
  expect(isAdmin).toBe(true);
  
  // Demote back
  await User.updateOne({ _id: user._id }, { role: "user" });
  
  // Both layers reflect immediately
  const socketAuthz2 = await authorizeSocketIdentity({ userId: user._id.toString() });
  expect(socketAuthz2.role).toBe("user");
  
  const isAdmin2 = await hasActiveAdminRole(req, user._id.toString());
  expect(isAdmin2).toBe(false);
});
```

---

## Test Execution Strategy

### Phase 1: Unit Tests (Fast)
- Run tests 7.1-7.2 (can mock DB)
- Verify token validation logic in isolation
- Verify claim validation

### Phase 2: Integration Tests (Medium)
- Run tests with real MongoDB
- Verify session storage and rotation
- Verify user lookups

### Phase 3: End-to-End Tests (Slow)
- Full login → refresh → logout flow
- Cross-layer consistency checks
- Compromise scenario simulations

### Phase 4: Chaos Engineering
- Simulate DB failures during auth
- Simulate network timeouts
- Simulate concurrent users

### Test Coverage Targets
- **Target:** 100% coverage of auth critical paths
- **Minimum acceptable:** 85% coverage
- **Critical files:** verify.ts, refresh.service.ts, logout.service.ts, auth.ts (socket), verify-session.ts

---

# PART 8: FINDINGS SUMMARY & ROADMAP

## Implementation Update (March 24, 2026)

- ✅ Implemented: active-user enforcement tightened in shared auth resolution used by protected API routes.
- ✅ Implemented: OAuth check-then-create replaced with atomic upsert + strict active-status enforcement.
- ✅ Implemented: rate limiting added to login, register, refresh, logout, and Google callback auth endpoints.
- ✅ Implemented: auth rate limiting now uses Redis-backed global counters (with in-memory fallback if Redis is unavailable).
- ✅ Implemented: universal protected-route auth guard centralized via reusable auth/admin helpers and applied across protected API endpoints.
- ✅ Implemented: structured auth event logging for login/register/refresh/logout/Google callback success/failure paths with reason/IP/user-agent context.
- ✅ Implemented: refresh flow now validates session device fingerprint (user-agent + IP bucket) and rejects mismatches.
- ✅ Implemented: refresh token/session/cookie TTL hardened from 7 days to 24 hours.
- ✅ Implemented: suspicious refresh attempts now trigger step-up-required response (`AUTH_STEP_UP_REQUIRED`) and session revocation.
- ✅ Implemented: tokenVersion-based emergency revocation (token claims + verification gates + session purge on admin ban).
- ✅ Implemented: client-side step-up recovery detection and graceful redirect with context (api.ts, UserContext.tsx, login/page.tsx).
- ✅ Implemented: full step-up challenge flow (challenge model + challenge verification endpoint + middleware enforcement + `/auth/challenge` page).
- ✅ Implemented: step-up integration tests for refresh/challenge success/failure/expiry/reuse scenarios.
- ✅ Implemented: dedicated best-effort security event logger utility for step-up events.
- ✅ Implemented: provider-aware OAuth identity resolution (Google subject-first, controlled email fallback, strict mismatch rejection).
- ✅ Implemented: admin auth-events visibility expansion for revocation + step-up events with event name, outcome, and reason details.

## Critical Issues (Fix Immediately)

| # | Category | Issue | Status | Residual Risk |
|---|----------|-------|--------|---------------|
| 1 | **Access Control** | Banned user can act in HTTP API for 15 min | ✅ Mitigated for shared-auth protected routes | LOW-MEDIUM |
| 2 | **Account Takeover** | OAuth upsert race condition | ✅ Mitigated with atomic upsert | LOW |
| 3 | **DoS** | No rate limiting on auth endpoints | ✅ Mitigated on core auth endpoints | LOW-MEDIUM |
| 4 | **Access Control** | No universal protected-route auth guard | ✅ Mitigated via centralized route guards | LOW |
| 5 | **Visibility** | No audit logging | ✅ Mitigated with structured auth-event logging | LOW-MEDIUM |
| 6 | **Visibility** | No device fingerprinting | ✅ Mitigated on refresh path with mismatch rejection | LOW-MEDIUM |
| 7 | **Token Management** | Risk-based step-up challenge UX | ✅ Implemented end-to-end challenge flow with middleware enforcement | LOW |

---

## High-Priority Issues (Fix This Quarter)

| # | Category | Issue | Mitigation |
|---|----------|-------|-----------|
| 8 | **Identity Policy** | OAuth linking remains email-centric | ✅ Implemented provider-aware linking policy (subject-first + guarded fallback) |

---

## Medium-Priority Issues (Backlog)

| # | Category | Issue | Mitigation |
|---|----------|-------|-----------|
| 9 | **Visibility** | Admin security event visibility incomplete | ✅ Implemented admin dashboard visibility for step-up + revocation event families |

---

## Estimated Remaining Effort

| Fix | Complexity | Time | Testing |
|-----|-----------|------|---------|
| OAuth provider-aware linking policy hardening | Completed | 0h | 0h |
| Admin security event visibility (step-up + revocation) | Completed | 0h | 0h |
| **Total remaining** | | **0 hours** | **0 hours** |

---

## Recommended Next Steps

1. **Immediate (Completed):**
  - ✅ Wire client/session management to explicitly handle `AUTH_STEP_UP_REQUIRED` responses.
  - ✅ Detect step-up recovery flow and gracefully redirect with context parameter.
  - ✅ Display user-facing warning when session requires re-auth.
  - ✅ Add `/auth/challenge` page and password verification endpoint for step-up completion.
  - ✅ Enforce step-up in middleware until challenge is verified.

2. **This Week:**
  - ✅ Implemented provider-aware account-linking rules for OAuth identities.

3. **Next Sprint:**
  - ✅ Implemented admin visibility for revocation and step-up security events in dashboard/audit UI.

---



