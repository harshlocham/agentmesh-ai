# ADR-003: Socket Authorization Bridge

- Status: Accepted
- Scope: `apps/socket`, `apps/web/app/api/internal/socket/*`,
  `packages/types/utils/internal-bridge-auth.ts`, `packages/services/authorization.service.ts`
- Related: `docs/architecture/realtime-messaging-system.md`,
  `docs/architecture/authentication-and-session-model.md`

## Context

The Socket.IO server (`apps/socket`) is a transport-only process. It owns no
schema and persists nothing about messages or conversations beyond presence
state in Redis. All authoritative authorization data — user existence, role,
ban status, conversation membership, message ownership — lives in MongoDB and
is reachable through the Next.js web app's models and services.

Two incompatible properties drive this ADR:

1. The socket server must accept hot-path operations (`message:send`,
   `conversation:join`) with low latency and **must not trust JWT claims
   alone** — a banned or deleted user holding a still-valid JWT must be
   rejected even before token expiry.
2. The socket server must remain decoupled from the MongoDB schema so it can
   scale horizontally (and so the schema can evolve without coordinated
   deploys).

The chosen pattern is an **internal HTTP bridge**: the socket server calls
private endpoints on the web app over the same network, authenticated by a
shared secret. The web app is the single point that touches MongoDB for
authorization decisions.

## Decision

### 1. Shared-secret authentication for internal traffic

`packages/types/utils/internal-bridge-auth.ts` defines the contract:

- Header name `x-internal-secret` (`INTERNAL_SECRET_HEADER`).
- `getInternalSecret()` reads `process.env.INTERNAL_SECRET` and throws if
  missing.
- `createInternalRequestHeaders()` is the only sanctioned way to construct
  outbound headers for internal calls; it pins `Content-Type: application/json`
  and the secret.
- `hasValidInternalSecret(provided, expected)` uses `crypto.timingSafeEqual`
  on equal-length `Buffer`s, returning `false` on a length mismatch instead of
  throwing. This avoids accidental timing leaks via `===`.

Both directions of the bridge use this contract:

- Socket → Web: `apps/socket/server/socket/services/internal-web-bridge.ts`
  builds requests via `createInternalRequestHeaders()`.
- Web → Socket: `apps/task-worker/index.ts` and
  `AgentRunner.emitTaskUpdated` use the same helper for outbound calls to the
  socket server's `/internal/*` endpoints.
- Inbound on either side: middleware verifies via `hasValidInternalSecret`. In
  the socket server, this is the express middleware
  `app.use("/internal", ...)` in `apps/socket/index.ts:65-73`. In the web
  server, every internal route (e.g. `apps/web/app/api/internal/socket/
  authorize-identity/route.ts`) checks the header before any work.

`INTERNAL_SECRET` is **required in production** for the worker
(`apps/task-worker/index.ts:60-69`). In development, it is allowed to be empty
to keep the dev experience low-friction.

### 2. Authorization decisions are HTTP calls, not RPC

There are three concrete authorization decisions exposed by the web app to
the socket server, each as a POST endpoint under
`/api/internal/socket/`:

| Endpoint | Caller | Purpose |
|---|---|---|
| `authorize-identity` | `socketAuth` middleware on connection | Validate that a JWT-bearing user exists, is active, and that `tokenVersion` matches MongoDB. |
| `authorize-conversation-access` | `registerMessageHandlers` (join/send) | Confirm the user is a participant of the conversation, with optional admin bypass. Returns participant IDs for fan-out. |
| `authorize-message-action` | `edit.handler.ts`, `delete.handler.ts` | Confirm the user may edit/delete a specific message in a specific conversation. |

Each socket-side caller has a typed wrapper in
`apps/socket/server/socket/services/`:

- `socket-identity-authorization.ts` → `authorizeSocketIdentity(payload)`.
- `conversation-access-authorization.ts` → `authorizeConversationAccess(payload)`.
- `message-action-authorization.ts` → `authorizeMessageAction(payload)`.

All three use the shared `postToInternalWebApi` helper in
`internal-web-bridge.ts`. This helper:

- Iterates over a list of candidate base URLs derived from
  `WEB_SERVER_URL`, comma-separated `ORIGIN`, and two
  `localhost`/`127.0.0.1` fallbacks (3000 and 3002). The fallbacks exist to
  smooth over local dev variations.
- Applies a per-request timeout, default 5 s, via `AbortController`.
- On `!response.ok` or thrown error, advances to the next candidate URL.
- Returns `null` if every candidate fails.

When the response is `null`, callers conservatively deny:
```ts
if (!data) return { allowed: false, reason: "authorization_service_unavailable" };
```

### 3. Socket handshake auth flow

`apps/socket/server/socket/middleware/auth.ts:90-119` performs the per-connection
check:

1. `getHandshakeToken(socket)` resolves the access token from, in order:
   `handshake.auth.accessToken`, `handshake.auth.token`,
   `Authorization: Bearer ...` header, or the `accessToken` cookie.
2. `verifyAccessToken(token)` validates the JWT with `algorithms: ["HS256"]`
   (explicit algorithm pinning to avoid algorithm-substitution attacks,
   commented at line 68). It returns
   `{ sub, role, tokenVersion, type: "access" }` and rejects non-`access`
   tokens or malformed payloads.
3. `authorizeSocketIdentity({ userId: sub, tokenVersion })` makes the HTTP
   call. The web endpoint cross-checks against
   `validateAuthUserById` which, by inspection of
   `apps/web/app/api/internal/socket/authorize-identity/route.ts`, supports a
   Redis cache (`useRedisCache: true, cacheTtlSeconds: 45`).
4. On `allowed: true`, the socket stores `socket.data.userId = sub` and
   `socket.data.isAdmin = (role === "admin")`. The socket joins
   `user:${userId}` for direct addressing.
5. On any failure path the middleware calls `next(new Error("Unauthorized"))`.

The auth middleware never throws into the socket pipeline; all errors funnel
to the generic "Unauthorized" string so as not to leak the failure reason to
the client. The internal endpoint returns precise reasons
(`user_banned`, `token_version_revoked`, etc.) for server-side logging.

### 4. Per-event authorization

Connection-time auth establishes identity. Per-event authorization is
re-checked at every operation that crosses a trust boundary:

- `conversation:join` and `message:send` call
  `authorizeConversationAccess` and refuse if `allowed = false` or
  `participantIds` is empty (`apps/socket/server/socket/handlers/message/
  message.handler.ts:67-99` and `109-154`). Denials are audit-logged with
  `auditUnauthorizedJoin` and the client gets an `error:auth` event of type
  `conversation_join_forbidden`.
- `message:send` additionally verifies the payload's `sender._id` matches
  `socket.data.userId` (line 151-154), so a compromised client cannot forge
  the sender identity.
- The `admin:join` handler refuses non-admin sockets even though the JWT
  contains the role: it reads `socket.data.isAdmin` set by the bridge during
  handshake (`apps/socket/server/socket/handlers/admin/admin.ts:10-15`).
- `typing:*` is **not authorized** server-side beyond the connection check.
  Typing events are emitted to `conversationMembers` chosen by the client; if
  the client lies, the worst case is leaking a `typing` ping to a non-member.
  This is documented as a known limitation in §Technical Debt.
- `message:delivered` and `message:seen` similarly **do not call back to the
  web bridge** today. They write to Redis and fan out to
  `user:${senderId}` / `conversation:${conversationId}` rooms.

### 5. Decoupling: socket emits via HTTP, not direct Redis

The socket server **does not pub/sub on Redis** for its message contracts;
it uses Redis only as a Socket.IO adapter (`@socket.io/redis-adapter` in
`apps/socket/server/socket/io.ts`) and as presence storage. When the worker or
the web app needs to push something to clients, it POSTs to the socket
server's `/internal/*` route, which in turn calls
`io.to(conversationId).emit(...)`. Bridge endpoints in `apps/socket/index.ts`:

```
/internal/message-deleted, /internal/message-reaction,
/internal/message-delivered, /internal/message-seen,
/internal/conversation-created, /internal/task-created,
/internal/task-updated, /internal/task-linked-to-message,
/internal/task-execution-updated, /internal/message-semantic-updated
```

This trades one extra HTTP hop for a uniform secret-guarded ingress.

## Tradeoffs

- **HTTP round-trip per socket op**. Connection-time identity check, every
  `conversation:join`, every `message:send`, every `edit`/`delete` carries an
  internal HTTP call. The 45 s Redis cache on `validateAuthUserById` mitigates
  this for the identity check but not for conversation access. With Node's
  keep-alive defaults the cost is sub-millisecond on the same host; across
  zones it becomes meaningful.
- **`fetch` fan-out on failure**. `postToInternalWebApi` tries multiple base
  URLs sequentially with 5 s each. A web outage holds the socket call open for
  up to `5s × N` candidates before falling back to "deny". For a busy server,
  this can stack head-of-line. There is no concurrent fan-out and no jittered
  re-balance.
- **One shared secret for all internal traffic**. There is no per-service
  identity or scope. A leak of `INTERNAL_SECRET` from any process compromises
  every direction.
- **Conservative deny on bridge failure**. When the web app is unhealthy the
  socket refuses joins and message sends. Presence and typing still work
  because they do not use the bridge. This is intentional: stale clients keep
  seeing typing pings but cannot send or join, signaling "system degraded" to
  the user.

## Failure Handling

| Failure | Behavior | Recovery |
|---|---|---|
| Internal secret missing on socket inbound | 401 from express middleware | Caller (worker or web) sees `internal emit failed: 401` and the outbox retries the bridge call. |
| Web app down | `postToInternalWebApi` returns `null` after timing out every candidate | Socket handler emits `error:auth` to the offending client and audits a `denied` log. |
| Stale JWT (banned/deleted user) | `validateAuthUserById` rejects | `authorizeSocketIdentity` returns `allowed: false` with a precise `reason`; socket disconnects on next event. Cached for 45 s — so revocation is not instant. |
| Token version revoked mid-session | Same as above on next handshake; existing connection persists | The web layer can call `invalidateAllUserTokens` to bump `tokenVersion`; subsequent handshakes fail. Live socket connections need to drop and reconnect. |
| Race on `conversation:join` denial | `socket.emit("error:auth")` and bail | Client is expected to surface the error and not re-attempt automatically. |

## Scalability Considerations

- The bridge is stateless on the socket side. Multiple socket pods can share
  the same Redis adapter and the same web backend.
- Connection-time bridge call is one POST per socket; `message:send` is one
  POST per message. For 10k connected users sending 1 msg/s, that is 10k
  POSTs/s against the web app's `/api/internal/socket/*` routes. These routes
  are intentionally thin (model lookup + admin-bypass check) and benefit
  from MongoDB participant-index hits.
- `validateAuthUserById` Redis cache keyed on
  `(userId, tokenVersion)` deduplicates identity checks across socket pods.
  Conversation-access has no such cache, so it is the hottest path. A future
  optimization would key a short-TTL cache on
  `(userId, conversationId, participants-hash)`.

## Technical Debt / Limitations

1. **Typing handler is not authorized**. `typingHandler` accepts
   `conversationMembers` from the client and emits to those user rooms. A
   malicious client could spray typing pings to other users' rooms. The
   relayed payload is innocuous (`{ conversationId, userId }`), but the
   information disclosure ("user X is online and using the chat") is real.
2. **Delivery and seen handlers bypass the bridge**. `deliveredHandler` and
   `SeenHandler` only validate that the user is connected; they do not check
   conversation membership. A client could mark messages as seen in a
   conversation it does not belong to. Redis state would record this and
   downstream emits would fan out to the conversation room (which the client
   isn't joined to, so no peers see it). Still, this writes garbage state into
   `message_delivery:*` keys.
3. **No HMAC over body, only secret over header**. A man-in-the-middle on the
   internal network could replay the same request body against the bridge as
   long as they have the secret. The secret should be rotated periodically;
   no rotation primitive exists in the code.
4. **`postToInternalWebApi` retries are URL-fanout, not retry**. There is no
   exponential backoff and no retry of the same URL after a transient 5xx.
5. **Cache invalidation lag**. The 45 s Redis cache on
   `validateAuthUserById` means a banned user can keep new connections live
   for up to 45 seconds after the ban. Active connections persist for as long
   as the access token is valid (15 min) because there is no proactive cache
   bust on the socket side.

## Future Evolution

- Replace the shared-secret with a per-service mTLS or a short-lived
  service-to-service JWT issued by the web app's KMS-equivalent.
- Add HMAC body signing on top of the secret to bind the body to the request.
- Add a `socket:disconnect` notification channel from the web app to the
  socket server: when `invalidateAllUserTokens` runs, push an event that the
  socket server consumes (probably via Redis pub/sub) to evict live
  connections for that user. This is the cleanest fix for cache lag.
- Move `conversation:join` authorization to a short-TTL cache keyed on
  `(userId, conversationId)` invalidated by participant changes.
- Authorize `typing`, `delivered`, and `seen` symmetrically with `send` by
  routing them through `authorizeConversationAccess`. The cost is one extra
  bridge call per event, which is non-trivial; introduce caching first.

## Uncertain

- The exact behavior of `validateAuthUserById` when the cache is unavailable
  (Redis down) was not inspected here; the function lives in
  `apps/web/lib/utils/auth/validateAuthUser.ts` and is referenced by route
  handlers. It is assumed to fall back to MongoDB unconditionally.
- Whether the socket server runs in a private network or is exposed via a
  reverse proxy is deployment-dependent; the secret check is the only
  enforcement.
