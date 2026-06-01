# Realtime Messaging System

## Purpose

`apps/socket` is the realtime delivery plane for chat messages, typing
signals, presence, message lifecycle events (delivered/seen/edit/delete/
reaction), and task lifecycle events. It is a Node Express + Socket.IO
process that is intentionally **persistence-free for chat state**: it owns
only ephemeral state in Redis and forwards all reads/writes to either the web
app (authoritative MongoDB) or the task worker (autonomous execution).

This document describes the topology, delivery semantics, and operational
properties. Authorization specifics live in
[ADR-003](../decisions/ADR-003-socket-authorization-bridge.md).

## Responsibilities

- Per-connection authentication (`socketAuth` middleware).
- Per-event authorization via the internal HTTP bridge.
- Room membership: `user:${userId}` and `conversation:${conversationId}`.
- Presence tracking and broadcasting (online/offline + heartbeat sweep).
- Typing relay.
- Message lifecycle relay (delivered, seen, edit, delete, reaction).
- Task lifecycle relay (`task:created`, `task:updated`,
  `task:linked_to_message`, `task:execution:updated`).
- Admin dashboard fan-out (`admin:*`).

The socket server is explicitly **not** the source of truth for messages.
This is enforced in code: `apps/socket/server/socket/controllers/
message.controller.ts` documents in a header comment that "Socket server is
transport-only by architecture. Message persistence must happen in the
web/API layer." The controller does not call MongoDB.

## Key Components

| Component | File | Role |
|---|---|---|
| HTTP entrypoint | `apps/socket/index.ts` | Express server with `/health` and `/internal/*` routes. |
| Socket bootstrap | `apps/socket/server/socket/index.ts` | Registers all handlers, starts presence sweeper. |
| `io` factory | `apps/socket/server/socket/io.ts` | Sets `path: "/api/socket"`, CORS, Redis adapter. |
| Redis clients | `apps/socket/server/socket/redis.ts` | Real (`ioredis`) or in-memory shim. |
| Auth middleware | `apps/socket/server/socket/middleware/auth.ts` | JWT verify + identity bridge call. |
| Event names | `packages/types/socket/events.ts` | Single source for `SocketEvents`, `ServerToClientEvents`, `ClientToServerEvents`. |
| Emit utilities | `apps/socket/server/socket/emit.ts` | `emitToConversation`, `emitToUser`, `emitToSocketServer`. |
| Handlers | `apps/socket/server/socket/handlers/*` | Per-domain handler registration. |
| Presence service | `apps/socket/server/socket/services/presence.redis.service.ts` | Redis-backed presence and delivery state. |
| Internal bridge clients | `apps/socket/server/socket/services/*-authorization.ts`, `internal-web-bridge.ts` | Outbound calls to web API. |

## Connection Lifecycle

```
┌──────────────────┐  upgrade + handshake (token in auth/header/cookie)
│      Client      │ ────────────────────────────────────────────────────▶
└──────────────────┘
                       ┌────────────────────────────────────────────┐
                       │ apps/socket Express + Socket.IO            │
                       │   io.use(socketAuth)                       │
                       │     ├─ verifyAccessToken(token) [HS256]    │
                       │     └─ authorizeSocketIdentity(...)        │ HTTP
                       │              │                             │ POST
                       │              ▼                             │ ──▶ apps/web
                       │   socket.data.userId, isAdmin              │     /api/internal/socket
                       │   socket.join("user:${userId}")            │     /authorize-identity
                       │   trackSocketConnected → Redis             │
                       │   USER_ONLINE broadcast to all sockets     │
                       └────────────────────────────────────────────┘
```

The handshake performs **two** trust checks:

1. JWT signature & shape (`verifyAccessToken`,
   `apps/socket/server/socket/middleware/auth.ts:61-83`). Algorithm pinned to
   `HS256` to avoid algorithm-substitution; explicit `type === "access"`
   gate; explicit `tokenVersion` extraction (defaulting to 0).
2. Database identity (`authorizeSocketIdentity`,
   `apps/socket/server/socket/services/socket-identity-authorization.ts`).
   The web app returns `allowed: false` for banned, deleted, or
   `tokenVersion`-mismatched users.

Both are required. The middleware rejects with the generic message
`"Unauthorized"` (`auth.ts:117`) to avoid leaking which step failed.

After successful auth:

- `presenceHandler` (`presence/presence.handler.ts:13-30`) runs:
  - `trackSocketConnected(userId, socketId)` writes
    `user_sockets:${userId}` SET membership, `online_user:${userId}` flag,
    refreshes `presence:${userId}` heartbeat, and adds to
    `active_users` SET.
  - The socket joins `user:${userId}`.
  - The full active user list is fetched and broadcast as `USER_ONLINE`
    (with `socketCount`) to **all sockets** via `io.emit`. This is a
    pre-existing tradeoff: presence updates are global, not per-conversation.

## Event Topology

`packages/types/socket/events.ts` is the central catalog. It has 60+ event
constants; the canonical event names below come from the constant strings
declared in that file.

### Server → Client emissions

| Domain | Event | Producer | Carrier |
|---|---|---|---|
| Presence | `user:online`, `user:offline`, `user:logout`, `users:active` | socket connect/disconnect/sweeper; client logout broadcast | `io.emit` (global) |
| Conversation | `conversation:joined`, `conversation:left`, `conversation:created`, `conversation:updated`, `conversation:deleted` | `messageHandler`, web bridge `/internal/conversation-*` | `conversation:${id}` |
| Messages | `message:new`, `message:edited`, `message:deleted`, `message:reaction`, `message:semantic_updated` | `messageHandler`, web bridge `/internal/message-*` | `conversation:${id}` and direct `user:${id}` (for `message:new`) |
| Delivery | `message:delivered_update`, `message:seen_update` | `deliveredHandler`, `seenHandler`, also internal bridge | `user:${senderId}` |
| Typing | `typing:start`, `typing:stop` | `typingHandler` | per-user `user:${id}` rooms in conversation members |
| Tasks | `task:created`, `task:updated`, `task:linked_to_message`, `task:execution:updated` | task worker via `/internal/task-*` | `conversation:${id}` |
| Admin | `admin:dashboard_init`, `admin:user_activity`, `admin:message_volume` | `adminHandler` (only on `admins` room) | `io.to("admins").emit(...)` |
| Auth | `error:auth` (`forbidden`, `unauthorized`, …) | `messageHandler` denials | direct socket |
| Heartbeat | `presence:ping` (response) | server-side ack | direct socket |

### Client → Server requests

`ClientToServerEvents` in `packages/types/socket/events.ts:178-262` lists
every accepted inbound event. Notable groups:

- `conversation:join`, `conversation:leave`: bridge-authorized.
- `message:send`, `message:edit`, `message:delete`, `message:react`,
  `message:react_remove`: bridge-authorized via
  `authorizeConversationAccess` and `authorizeMessageAction`.
- `message:delivered`, `message:seen`: **not** bridge-authorized
  (see Limitations).
- `typing:start`, `typing:stop`: **not** bridge-authorized (see
  Limitations).
- `presence:ping`: heartbeat.
- `admin:*`: gated by `socket.data.isAdmin` only.

### Internal HTTP bridge (web/worker → socket)

`apps/socket/index.ts:65-241` declares all internal POST endpoints. Each
endpoint validates `x-internal-secret` then either:

- Emits via `emitToConversation(conversationId, eventName, payload)`.
- Or emits via `emitToUser(userId, eventName, payload)` (used for
  delivered/seen updates).

| Internal route | Emits | Room |
|---|---|---|
| `/internal/message-deleted` | `message:deleted` | `conversation:${id}` |
| `/internal/message-reaction` | `message:reaction` | `conversation:${id}` |
| `/internal/message-delivered` | `message:delivered_update` | `user:${senderId}` |
| `/internal/message-seen` | `message:seen_update` | `user:${senderId}` |
| `/internal/conversation-created` | `conversation:created` | `conversation:${id}` |
| `/internal/task-created` | `task:created` | `conversation:${id}` |
| `/internal/task-updated` | `task:updated` | `conversation:${id}` |
| `/internal/task-linked-to-message` | `task:linked_to_message` | `conversation:${id}` |
| `/internal/task-execution-updated` | `task:execution:updated` | `conversation:${id}` |
| `/internal/message-semantic-updated` | `message:semantic_updated` | `conversation:${id}` |

This is the entire surface that lets producers outside the socket process
push events to connected clients.

## Delivery Semantics

`MESSAGE_SEND` is the canonical hot path
(`apps/socket/server/socket/handlers/message/message.handler.ts:109-217`):

1. Authorize `(userId, conversationId)` via
   `authorizeConversationAccess`.
2. Verify `data.sender._id === socket.data.userId`. Reject on mismatch with
   `error:auth { code: "sender_mismatch" }`.
3. Stamp delivery state in Redis: `setMessageDeliveryState(messageId,
   { state: "sent" })` with TTL `MESSAGE_DELIVERY_TTL_SECONDS = 30d`.
4. `emitToConversation(conversationId, MESSAGE_NEW, message)`.
5. **Per-recipient direct fan-out** for online users not currently
   viewing that conversation: each `participant ∈ participantIds`,
   `if (await isUserOnline(p)) emitToUser(p, MESSAGE_NEW, message)`. This is
   redundant fan-out — if the user is in the conversation room, they receive
   the message twice. Clients are expected to dedupe on `message._id`.
6. For each recipient whose active conversation matches, immediately mark
   the message as delivered (`setMessageDeliveryState("delivered")`) and
   emit `MESSAGE_DELIVERED_UPDATE` to the sender. This is the optimistic
   "auto-delivered if already viewing" path.

There is **no persistence** of the message itself in the socket server. The
caller (the web app or a client) is expected to have persisted it via
`POST /api/conversations/:id/messages` *before* emitting. The two writes are
not coupled — a misbehaving client could emit without persisting; receivers
would briefly see the message, then refresh and see it disappear. This is a
known correctness boundary documented in the controller header comment.

`MESSAGE_DELIVERED` (`delivery/delivered.handler.ts`) and `MESSAGE_SEEN`
(`delivery/seen.handler.ts`) follow a similar Redis-state + sender-notify
pattern. The `seen` handler accepts an array of `messageIds` and processes
them sequentially, emitting one update per id.

### Ordering and at-least-once

- Per-socket order is preserved by Socket.IO (TCP-backed). Per-conversation
  order across multiple senders is whatever order their packets arrive at
  the broker — there is no monotonic per-conversation sequence.
- There is no message ack. Delivery is "best effort, fire and forget" from
  the server's perspective; the client's local `MESSAGE_NEW` handler must
  reconcile against the persisted REST view to detect drops.
- The redundant fan-out (room + direct) raises the probability of delivery
  for clients who are joined late or who haven't yet completed
  `conversation:join`.

## Presence Tracking

Implemented in `apps/socket/server/socket/services/presence.redis.service.ts`
with all keys defined in `keys.ts`.

State per user:

```
user_sockets:${userId}              SET    socketIds currently connected
online_user:${userId}               STR    "1"      (deprecated, kept for legacy code)
user_active_conv:${userId}          STR    conversationId or empty
presence:${userId}                  STR    "1"      TTL = PRESENCE_HEARTBEAT_TTL_SECONDS (60s)
active_users                        SET    userIds with at least one connected socket
message_delivery:${messageId}       HASH   { state, deliveredAt, seenAt }     TTL 30d
```

A user is "online" iff:

1. `user_sockets:${userId}` is non-empty, AND
2. `presence:${userId}` key has not expired (`isUserOnline` checks both).

`refreshPresence(userId)` re-sets the TTL. The client emits `presence:ping`
periodically to refresh; `presenceHandler` re-calls `refreshPresence`.

### Sweeper

`apps/socket/server/socket/index.ts:48-72` starts a 5 s interval that calls
`cleanupStaleActiveUsers()`. The cleanup:

1. `SMEMBERS active_users` → for each, check `presence:${userId}` TTL.
2. If expired and `user_sockets:${userId}` is empty: `SREM active_users
   ${userId}`, delete `online_user:${userId}`, return `userId` as
   "gone offline."
3. For each newly-offline user, `io.emit(USER_OFFLINE, { userId, ts })`.

This guarantees the presence state self-heals after at most 60 s (heartbeat
TTL) + 5 s (sweep interval), even if a socket disconnects ungracefully and
its `disconnect` handler never fires (e.g., process kill).

## Typing Indicators

`apps/socket/server/socket/handlers/typing/typing.handler.ts:6-49`:

`relayTypingEvent` is given a sender, conversationId, and optional
`conversationMembers: string[]`:

- If `conversationMembers` is provided, emit to each
  `user:${memberId}` excluding the sender.
- Otherwise, fan out to the conversation room and exclude the sender's
  socket (`socket.broadcast.to(conversationRoom)`).

There is no server-side membership check. The conversationMembers list is
client-provided. See ADR-003 §Technical Debt for the security caveat.

## Admin Channel

`adminHandler` (`handlers/admin/admin.ts`) is the only handler that gates by
`socket.data.isAdmin` set at handshake time:

- `admin:join` adds the socket to the `admins` room and emits
  `admin:dashboard_init` with `{ activeUsers, totalMessagesToday: 0,
  serverUptime, connections }`. The `totalMessagesToday` is hardcoded to 0
  in the handler — this is **not** wired up.

There is no consumer-side message counter in the socket server because
persistence does not live here.

## Redis: Adapter vs Application State

Two distinct uses of Redis:

1. **Socket.IO adapter** (`@socket.io/redis-adapter` in `io.ts:34-42`).
   Used to coordinate `io.to(room).emit(...)` fan-out across socket pods.
   Without this, two pods would each have a separate room registry. The
   adapter is **only** enabled when `REDIS_URL` is set and connection
   succeeds; otherwise a console warning is printed and the server runs in
   "in-memory single-pod" mode.
2. **Application state** (presence, delivery, active conversation, active
   users set). Reads and writes use `getAppRedis()`. In dev without Redis,
   `apps/socket/server/socket/redis.ts:13-160` provides a full in-memory
   shim — including a `batch()` impl — so the server runs without Redis at
   all. **This shim is intentionally not horizontally scalable** and there
   is a console warning at startup.

## Tradeoffs

- **Decoupling vs hop count**. Every authorization decision is an HTTP call
  to the web app. This keeps the socket process schema-free and stateless,
  but inflates per-event latency and creates a hard dependency on the web
  app's uptime for any authorized operation.
- **Redundant fan-out vs ordering**. The `MESSAGE_SEND` handler emits to
  both the conversation room and to each online participant directly. This
  raises delivery probability for clients who haven't joined the room yet,
  at the cost of duplicate delivery and unnecessary bandwidth for clients
  who are in the room. Clients dedupe.
- **Global presence broadcast vs scoped**. `USER_ONLINE`/`USER_OFFLINE` is
  emitted with `io.emit`, reaching every connected socket. At scale this is
  O(N²) in connection count for a fully connected user base. The simpler
  alternative — emit only to mutual conversation participants — would
  require a contact-graph lookup.
- **Stateless socket process**. No message persistence means the socket
  process can be restarted at will, but every restart causes
  reconnect storms.

## Failure Handling

| Failure | Behavior |
|---|---|
| Web app down during handshake | Identity authorization returns `null`; `socketAuth` rejects with `Unauthorized`. New connections fail. Existing connections remain authenticated by token but lose authorization on any `join`/`send`. |
| Web app down during `message:send` | `authorizeConversationAccess` returns `{ allowed: false, reason: "authorization_service_unavailable" }`; sender receives `error:auth` with code `service_unavailable`. |
| Redis adapter down | Cross-pod emits silently degrade (adapter throws on emit). Per-pod emits still work. No client-visible error. |
| Application Redis down | Presence and delivery state lose persistence. `isUserOnline` returns false. The auto-delivered shortcut path stops firing. Sweeper continues to run and is a no-op. |
| Socket process crash | All connections drop. Clients reconnect; presence rebuilds from new connections; sweeper expires stale state in <65 s. |
| Client misbehaves (forged sender) | `MESSAGE_SEND` rejects with `error:auth { code: "sender_mismatch" }`; conversation join/send denied. Typing and delivered/seen pass through (limitation). |

## Scalability Considerations

- **Horizontal scale**: requires Redis. The adapter handles cross-pod
  room emits. The presence sweeper runs on every pod independently — this
  is harmless because the underlying ops are idempotent and use SET
  semantics; the only cost is N× the sweeper traffic.
- **Connection density**: not benchmarked in code; standard Socket.IO
  limits (~10–30k per pod, depending on memory and event volume) apply.
- **Fan-out cost**: `USER_ONLINE` broadcast scales with total connected
  sockets. At 10k sockets this is 10k emits per connection event. If
  presence churn is high (mobile clients on flaky networks), this becomes
  the dominant CPU cost.
- **Internal bridge load**: every `message:send` does one
  `authorizeConversationAccess` POST to the web app. At 1k msgs/s
  cluster-wide that is 1k POSTs/s. The web route is intentionally thin but
  must be sized accordingly.

## Technical Debt / Limitations

1. **Typing, delivered, and seen are not authorized**. Clients can mark
   messages seen they didn't see, and broadcast typing to channels they
   don't belong to. See ADR-003 §Technical Debt for the rationale.
2. **Sender authority is only checked in `MESSAGE_SEND`**. `message:edit`,
   `message:delete`, `message:react` rely on `authorizeMessageAction`'s
   web-side checks. There is no defense-in-depth at the socket layer beyond
   the bridge call.
3. **Hard-coded admin metrics**. `admin:dashboard_init.totalMessagesToday`
   is `0`. Either remove or wire up.
4. **`emitToConversation` and `emitToUser` swallow errors when the adapter
   is missing**. There is no observability when an emit fails to cross
   pods.
5. **`SocketEvents` constants exceed handler coverage**. Many constants in
   `events.ts` (e.g. `MESSAGE_DELIVERY_FAILED`, `TASK_EXECUTION_*`,
   `CONVERSATION_LEFT`, `ADMIN_USER_ACTIVITY`) have no producer in the
   socket server. They appear to be reserved for future use or used only
   in the client. A producer-consumer audit is needed.
6. **In-memory Redis shim** is not safe to ship to production but the
   server will silently run without Redis if connection fails in
   development. Production safety relies on operators noticing the startup
   warning.
7. **Two parallel sweeps**: `presenceSweep` cleans active users; there is
   no dedicated sweep for `message_delivery:*` keys, which rely on the
   30 d TTL set at write time.

## Future Evolution

- Move `delivered`/`seen` and `typing` through `authorizeConversationAccess`
  with a short-lived `(userId, conversationId)` cache to keep latency
  acceptable.
- Replace global `USER_ONLINE` broadcasts with per-contact emit using the
  user's contact graph.
- Add Redis Streams or pub/sub for inbound webhooks to enable
  worker → client emits without going through HTTP `/internal/*` (avoiding
  the second hop and unblocking offline-message buffering).
- Add a `socket:disconnect` channel from web to socket to evict live
  sessions on password change / ban (see ADR-003).
- Add structured logging and metrics on adapter health, internal-bridge
  latency, and per-event reject rates.

## Uncertain

- Whether mobile clients dedupe `message:new` from the redundant fan-out is
  client-side and not visible here.
- Several of the unused `SocketEvents` constants might be wired up in
  client code (`apps/web`, `apps/mobile`); a fan-out audit needs to scan
  those.
- The exact `MESSAGE_DELIVERY_TTL_SECONDS = 30d` window is generous and
  appears intended for offline-message bookkeeping, but no consumer
  currently reads this state outside the request that wrote it.
