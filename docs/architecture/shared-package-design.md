# Shared Package Design

## Purpose

This monorepo separates **transport** from **schema**, **schema** from
**logic**, and **logic** from **runtime configuration**. The five shared
packages under `packages/` are the seams along which apps (`apps/web`,
`apps/socket`, `apps/task-worker`, `apps/mobile`) are kept independent at
deploy time while sharing a single source of truth for data shapes and
domain operations.

This document explains what each package owns, why the seams are drawn
where they are, how the dependency graph is enforced, and the seams that
are currently leaky.

## Package Layout

```
packages/
├── types/      # Pure TypeScript types + a few framework-free utilities.
├── db/         # MongoDB models, indexes, connection helpers.
├── auth/       # JWT, sessions, fingerprinting, OTP, step-up.
├── services/   # Domain logic that reads/writes db, emits events.
└── redis/      # Re-export shim around apps/socket Redis client.
```

Workspace declaration in `pnpm-workspace.yaml`:

```yaml
packages:
  - "apps/*"
  - "packages/*"
```

All inter-package references use `workspace:*` (e.g.
`"@chat/types": "workspace:*"`), enforced by pnpm.

## Dependency Graph (Actual)

Read from `package.json` `dependencies` fields and `import` statements:

```
                  ┌───────────────────────────────┐
                  │            @chat/types        │
                  │  (no internal deps)           │
                  └────────────┬──────────────────┘
                               │
                ┌──────────────┼──────────────────┬──────────────┐
                │              │                  │              │
                ▼              ▼                  ▼              ▼
        ┌──────────┐    ┌──────────┐      ┌────────────┐  ┌──────────┐
        │ @chat/db │    │@chat/auth│      │@chat/redis │  │ apps/web │
        │  (mongo) │    │ (jwt,    │      │ (re-export │  │ apps/    │
        └─────┬────┘    │  bcrypt) │      │  apps/sock │  │ socket   │
              │         └────┬─────┘      │  redis)    │  │ apps/    │
              │              │             └────────────┘  │ mobile   │
              ▼              │                              │ apps/    │
        ┌──────────────┐     │                              │ taskwrk  │
        │@chat/services│ ◀───┘   (auth depends on db via    └──────────┘
        │ (domain ops) │          alias @/models)
        └──────┬───────┘
               │
               ▼
        ┌─────────────────────────────────────────────────────┐
        │  apps/web, apps/socket, apps/task-worker, apps/     │
        │  mobile  — consumers only                           │
        └─────────────────────────────────────────────────────┘
```

A few details worth calling out:

- `@chat/types` has **zero internal dependencies** and no runtime side
  effects. It is pure type declarations plus a small set of plain-function
  utilities (`internal-bridge-auth.ts`, `message.guard.ts`). It is the
  cheapest package to depend on.
- `@chat/auth` does not import `@chat/db` directly. It uses `@/models/...`
  TypeScript path aliases (set up per-app `tsconfig.json`) to import the
  same Mongoose models from `packages/db/models`. This is **leaky** — the
  same model is reachable as `@/models/User`, `@chat/db/models/User`, and
  in production builds, the actual built path. See §Technical Debt.
- `@chat/redis` is a one-line re-export of
  `apps/socket/server/socket/redis.ts` and `presence.redis.service.ts`.
  This effectively makes the socket app the **owner** of the Redis client
  abstraction, with `packages/redis` as a thin re-export surface for
  other apps. See §Why an app owns the Redis client.
- `@chat/services` builds on `@chat/db` and `@chat/types`; it does not
  depend on `@chat/auth`. Services that need an authenticated user
  receive `userId` as a parameter; they do not authenticate themselves.

## Per-Package Responsibilities

### `@chat/types`

- **Owns**: Shape of every cross-process payload (socket events, task
  execution events, message DTOs, plan/memory/reflection types) and
  shared utility constants like `INTERNAL_SECRET_HEADER`.
- **Source of truth for**:
  - `SocketEvents` (60+ event name constants) and
    `ServerToClientEvents` / `ClientToServerEvents`
    (`socket/events.ts`).
  - `TaskExecutionEventType`, `TaskExecutionUpdatedPayload`
    (`task/execution-event.ts`).
  - `ExecutionStateKind`, `ExecutionEvent`, `TERMINAL_EXECUTION_STATES`
    (`task/execution-state.ts`).
  - DTOs for chat messages (`message/message.ts`, `dto/message.dto.ts`).
- **Constraints**: Build target produces both `.js` and `.d.ts`; no
  runtime dependencies on Node-only APIs except in
  `utils/internal-bridge-auth.ts` (which uses `node:crypto`).
- **Why separate**: Both Next.js (browser+server) and React Native (Hermes
  + Metro) need these types. A package that pulled in `mongoose` or
  `ioredis` would break Metro and inflate web client bundles.

Sub-export points (`package.json` `exports`):

| Export | Purpose |
|---|---|
| `@chat/types` | Default index. |
| `@chat/types/utils/message.guard` | Type guards safe to import in client code. |
| `@chat/types/utils/internal-bridge-auth` | Server-only, but small enough to ship alone. |

### `@chat/db`

- **Owns**: All Mongoose schemas, indexes, model classes, and the shared
  connection helper.
- **Source of truth for**: `User`, `Conversation`, `Message`,
  `Task`, `TaskAction`, `TaskExecutionEvent`, `TaskMemory`, `TaskPlan`,
  `TaskReflection`, `OutboxEvent`, `OTP`, `StepUpChallenge`,
  `MessageIntent`, `Contact`, `Devices`, `TempMessage`.
- **Constraints**: Server-only (`mongoose`). The `package.json` *does*
  list `dexie` — this exists for `apps/mobile` and the web client's
  offline-message cache (`offlineMessages.ts`). The package is therefore
  not strictly server-only, but the Mongoose-bearing modules are not
  importable from a browser bundle without breakage. Apps avoid this by
  importing specific subpaths: `@chat/db/offlineMessages` vs
  `@chat/db/models/User`.
- **Why separate**: Schemas need to be referenced from both the web app
  (REST handlers, internal endpoints) and the task worker (autonomous
  execution). Co-locating them in either app would force the other to
  reach across an app boundary. The shared package keeps the indexes,
  TTLs, and validation in one place.

Notably, the package does **not** expose repository classes; it exports
the raw `mongoose.model<...>` instance. Repositories live in
`@chat/services`. This means `Model.find(...)` is callable from anywhere
that imports `@chat/db`. A stricter separation (only repository
exports) would be safer but the choice keeps the surface area small.

### `@chat/auth`

- **Owns**: JWT generation/verification (`tokens/*`), session lifecycle
  (`session/*`), refresh + login + register + OTP + step-up services
  (`services/*`), HTTP and socket middleware shims (`middleware/*`),
  audit logging (`services/auth-audit.service.ts`).
- **Constraints**: Server-only (jsonwebtoken, bcryptjs, mongoose).
- **Why separate**: Authentication is *the* trust boundary; centralizing
  it removes the temptation to re-implement token verify in each app. It
  is consumed by `apps/web` for REST routes and indirectly by
  `apps/socket` (which uses only `verifyAccessToken` via
  `middleware/socket-auth.ts`).
- **Dependency leak**: `@chat/auth` imports models via `@/models/...`
  alias (configured in the consuming app's `tsconfig`). This means the
  package only resolves when consumed from a project that sets up that
  alias to point at the same `packages/db/models` directory. This is
  pragmatic but means `@chat/auth` cannot be consumed as a standalone
  artifact — it is essentially an in-tree extension of the web app. See
  §Technical Debt.

### `@chat/services`

- **Owns**: Domain operations that read/write `@chat/db` models, often
  emitting events through the outbox or the socket bridge. Roughly
  organized as:
  - `outbox.service.ts` — outbox claim/complete/dead-letter primitives.
  - `execution-event.service.ts` — `TaskExecutionEvent` persistence +
    sequencing.
  - `task-intelligence.service.ts` — message → task classification and
    creation.
  - `task.service.ts`, `message.service.ts`, `delivery.service.ts`,
    `seen.service.ts`, `typing.service.ts`, `presence.service.ts`,
    `contact.service.ts`, `call.service.ts` — domain ops per noun.
  - `authorization.service.ts` — `canAccessConversation`,
    `getAuthorizedConversation`, `assertConversationAccess`,
    `assertTaskAccess`. The web app's internal socket-authorization
    endpoints call into this.
  - `repositories/*.repo.ts` — DAO wrappers over `@chat/db` models.
  - `normalizers/*` and `tool-normalizers.ts` — shape transformations
    between DB models and DTOs.
  - `validators/*` — Zod schemas re-used across apps.
- **Constraints**: Server-only. Depends on `@chat/db`, `@chat/types`, and
  `zod`.
- **Why separate**: The web app and the task worker both need the same
  service logic. If it lived in the web app, the worker would need to
  reach into the web app's source tree or duplicate logic.

The `exports` field declares many fine-grained subpaths
(`@chat/services/outbox.service`, `@chat/services/execution-event.service`,
`@chat/services/contact.service`, …). This is important because:

- Tree-shaking from compiled JS is unreliable; explicit subpath imports
  let apps include only the modules they need.
- It documents the public API. A module not in `exports` is internal.

The package builds via `tsc` + two postbuild scripts
(`postbuild-fix.cjs`, `postbuild-resolve-imports.cjs`) that rewrite
TypeScript-style imports to ESM-compatible relative imports. This is a
workaround for `moduleResolution: "node16"` + `"type": "module"` quirks.
The packaging is fragile; a CI step `pnpm run ci:verify-artifacts`
sanity-checks output.

### `@chat/redis`

- **Owns**: A re-export of `apps/socket`'s Redis client and presence
  service. Two files:

  ```ts
  // packages/redis/redisClient.ts
  export { initRedis } from "../../apps/socket/server/socket/redis.js";

  // packages/redis/presenceService.ts
  export * from "../../apps/socket/server/socket/services/presence.redis.service.js";
  ```

- **Why**: Other apps (specifically, the web app and worker) need to
  call `getAppRedis()` and read presence state. Rather than duplicate
  the client setup, this shim points back at the socket app's
  implementation.
- **Dependency leak**: This violates the conceptual rule that `packages/*`
  must not depend on `apps/*`. In practice it works because pnpm
  resolves the relative path to the source files, and the socket app's
  `redis.ts` does not transitively pull in Socket.IO. But this is
  brittle: any refactor of `apps/socket/server/socket/redis.ts` can break
  the web app and the worker. See §Technical Debt.

## Why `services` is separated from `db`

Three reasons, in observed order of importance:

1. **Read/write composition.** Most service functions read 2–4 models and
   write to 1–2. Placing them on the model class would create either
   cross-model coupling on the schema (bad for index management) or
   "fat models" (bad for testability). The DAO pattern in
   `services/repositories/*.repo.ts` keeps queries cohesive without
   collapsing them into the schema.
2. **Outbox + event sequencing.** `execution-event.service.ts` does
   `allocateSequence + create` as a 2-step write, and
   `outbox.service.ts` does `findOneAndUpdate` + `incr attempts`. These
   are operations that span "model + side-effect"; putting them on the
   model is wrong.
3. **Validation.** Zod schemas in `validators/` are imported by both the
   service and by the web app's route handlers. If they lived in
   `@chat/db`, every consumer of a model would also import zod. Keeping
   them in `@chat/services` lets `@chat/db` stay framework-free.

## Why `auth` is separated from `services`

`@chat/auth` operates on its own models (`Session`, `AuthEvent`) and on
the shared `User` model. It is consumed by route handlers that need to
hand off `{ userId, role }` to `@chat/services` calls. Two layers
prevent circular dependencies:

- `@chat/auth` does **not** import `@chat/services`.
- `@chat/services` does **not** import `@chat/auth` (no auth lookups
  inside services).

This is enforced by inspection of each `package.json`'s
`dependencies`. Authorization decisions in `authorization.service.ts`
take a `userId` parameter, never a token.

## Why `types` is separated from everything

The mobile app uses React Native + Hermes; Metro cannot bundle
`mongoose`, `bcryptjs`, or `ioredis`. If types lived in `@chat/db`,
mobile would either need shim packages or a custom Metro config. The
extracted `@chat/types` is consumable by both Hermes and the web client.

A specific example: `apps/mobile` (`react-native`) imports
`SocketEvents` and the matching event payload types from `@chat/types`
to keep its Socket.IO client typed without pulling in anything
server-only.

## Build & Type Pipeline

Builds are coordinated by `turbo`:

- `turbo.json` declares `build`, `typecheck`, `test`, `lint` with
  `dependsOn: ["^build"]`. This means a package's typecheck/test cannot
  run until its workspace dependencies have built `.d.ts` files.
- Root `package.json` script `build` runs
  `turbo run build --filter=./apps/* --filter=./packages/*` — all
  artifacts produced in the correct order.
- Some packages declare their own ordered build: `apps/web` does
  `pnpm --filter @chat/types build && pnpm --filter @chat/db build &&
  pnpm --filter @chat/services build && next build`. This is a
  belt-and-suspenders measure; if turbo is invoked from the root, the
  ordering is implicit.

TypeScript is configured per-package:

- `@chat/types` and `@chat/db` build with `"type": "module"` and emit
  `.d.ts` + `.js` to `dist/`.
- `@chat/services` does the same but with two postbuild scripts to
  rewrite imports.
- `@chat/auth` has no `dist/`; it ships **TypeScript source** as `main`
  (`"main": "./index.ts"`). This works because every consumer is itself
  a TypeScript project that compiles `@chat/auth` as part of its own
  graph. It also means there is **no `.d.ts` published for `@chat/auth`** —
  consumers re-typecheck the source every build.

## Contract Enforcement

Cross-process contracts are enforced by:

1. **Single import site**. Both producer and consumer import from the
   same `@chat/types` module. There is no separate "client types" copy.
   For socket events specifically, `apps/web/src/lib/socket-client.ts`
   and `apps/socket/server/socket/handlers/...` both import from
   `@chat/types/socket/events`.
2. **Zod schemas at trust boundaries**. `packages/services/validators/`
   exports Zod schemas used by both the web API and the task worker for
   validating inbound payloads. Task tools also use Zod
   (`Tool.inputSchema`) — schema-as-validation is consistent across the
   codebase.
3. **`internal-bridge-auth`** constants. The internal HTTP bridge uses
   `INTERNAL_SECRET_HEADER` and `hasValidInternalSecret` from
   `@chat/types/utils/internal-bridge-auth` on both sides. A typo on
   either side would fail at the type level.
4. **Workspace versioning via changesets**. `package.json` `scripts`
   includes `changeset` and `version-packages`; each shared package has
   its own SemVer (`@chat/types@1.3.2`, `@chat/db@2.0.3`, etc.). A
   breaking change to a type is supposed to bump the package's major
   version and require apps to opt in. In practice, with all
   `workspace:*` consumers, the changeset version is documentary only —
   every commit ships everything together.

## Tradeoffs

- **Coarse package boundaries**. The five-package layout is small enough
  to reason about but encourages fat services (`@chat/services` has 23
  files spread across many domains). A finer split (`@chat/services-tasks`,
  `@chat/services-messages`, …) would tighten boundaries at the cost of
  build orchestration complexity.
- **`@chat/auth` ships source, not compiled output**. Faster iteration
  during development, no separate `.d.ts` to drift. But the package
  cannot be consumed outside a TypeScript-aware build, which is fine for
  this monorepo and wrong for any other consumer.
- **`workspace:*` everywhere** removes versioning ceremony but also
  removes the safety net of explicit major bumps. Any cross-cutting
  schema change is implicitly accepted by every consumer on the next
  build.
- **No `eslint` boundary rules**. There is no `import/no-restricted-paths`
  or `eslint-plugin-boundaries` configuration enforcing that, e.g.,
  `@chat/db` cannot import `@chat/services`. The dependency direction is
  observed by convention.

## Failure Handling (At the Package Boundary)

- **`@chat/db` connect failures**: `connectToDatabase()` caches the
  connection promise. On error it rejects; the caller (typically an app
  bootstrap) is expected to crash. There is no retry inside
  `@chat/db`.
- **`@chat/auth` config failures**: `requiredEnv(name)` throws at first
  access. Because the config is lazy-evaluated, the throw happens at the
  first auth call, not at process start. Apps that want eager validation
  should call `getAccessTokenConfig()` at boot.
- **`@chat/services` errors**: Most service functions throw on invalid
  inputs (via Zod) or return `null` on not-found. There is no uniform
  error envelope; callers must handle both shapes.
- **`@chat/redis` failures**: The re-exported `initRedis` already has a
  fallback to in-memory mode in non-production. Production callers
  should check `redis !== null` before using.

## Scalability Considerations

- **Type-only changes** in `@chat/types` are cheap: only `tsc` reruns,
  no runtime impact.
- **Schema changes** in `@chat/db` require coordinated migration
  across consumers and possibly explicit reindexing. The schemas use
  `optimisticConcurrency: true` on the hot models (`Task`) to detect
  conflicting writes.
- **Service signature changes** in `@chat/services` propagate to all
  callers in the same build. There is no API versioning.
- **Build performance**: turbo caches per-package outputs. The slowest
  package is `@chat/services` due to the postbuild scripts.
  Incremental development uses `tsx` on the app side (no compile
  step) and avoids the postbuild path entirely.

## Technical Debt / Limitations

1. **`@chat/redis` reaches into `apps/socket`**. The package depends on
   files inside an app, violating the conceptual layering. Either move
   the Redis client into `@chat/redis` proper, or rename `@chat/redis`
   to make the dependency direction explicit.
2. **`@chat/auth` uses `@/models/...` aliases**. This couples
   `@chat/auth`'s resolvability to the consuming app's `tsconfig`. The
   package should either depend on `@chat/db` explicitly or move the
   `Session` model into its own `repositories/sessionModel.ts` (already
   done) and stop importing the `User` model directly.
3. **`@chat/auth` does not compile to `dist/`**. Other packages do. The
   inconsistency means cross-package debugging mixes compiled and
   source files in the same stack trace.
4. **`@chat/services` exports models indirectly**. By re-exporting
   repositories that take Mongoose query options, the package leaks
   `mongoose` types into its public API. A web client that imports
   `@chat/services` for a Zod schema also pulls in mongoose typing.
5. **No `eslint-plugin-import` boundary rules**. The dependency direction
   `types → db → auth/services → apps` is by convention only.
6. **Several `@chat/types/socket/events.ts` constants have no producer**.
   Some events (`MESSAGE_DELIVERY_FAILED`, `ADMIN_USER_ACTIVITY`,
   `CONVERSATION_LEFT`, several `TASK_EXECUTION_*`) are typed but never
   emitted by any handler. See realtime doc.
7. **Validators duplicated between `@chat/services/validators` and tool
   `inputSchema`**. The tool registry uses ad-hoc `zod` schemas
   per-tool; the services package has its own. There is no single
   `task-action` schema.
8. **`packages/services/__tests__/`** exists but only covers
   `authorization.service.test.ts`. The rest is largely untested at
   this layer (tests for outbox/execution-event live in
   `apps/task-worker/tests`).

## Future Evolution

- Split `@chat/services` along domain lines (`@chat/services-tasks`,
  `@chat/services-messaging`, `@chat/services-auth-domain`) to make
  ownership clearer and incremental compilation cheaper.
- Move `@chat/redis` to own its client and presence service; reduce
  `apps/socket` to a consumer.
- Compile `@chat/auth` to `dist/` and stop exporting source as `main`,
  for symmetry with other packages and to enable proper `.d.ts`
  publication.
- Add an `eslint-plugin-boundaries` config that forbids cross-app
  imports and enforces the package dependency graph.
- Replace `@chat/auth`'s `@/models/...` aliases with explicit
  `@chat/db` imports.
- Add a `@chat/contracts` package that holds Zod schemas
  separately from `@chat/services`, so client apps can import the
  schemas without pulling in mongoose-typed repositories.

## Uncertain

- The exact reason `@chat/auth` ships source instead of compiled output
  is not documented anywhere in the repo; it appears to be a developer
  experience choice but might have started as an oversight.
- `@chat/redis`'s relative path to `apps/socket` works at build time but
  the behavior at install-from-tarball is untested. Since this is a
  private monorepo with `workspace:*`, it is unlikely to ever be
  installed differently.
- Whether changesets are actually generated for every cross-package
  change is operational; this can only be verified by inspecting CI
  history.
