# @chat/web

## 4.0.2

### Patch Changes

- 6c57198: Fix socket auth and deployment flow for production by normalizing origins, enabling cross-subdomain auth cookies, and binding the socket server to the Render-injected port.
- Updated dependencies [6c57198]
  - @chat/auth@2.3.2

## 4.0.1

### Patch Changes

- 67ff3ac: Publish dedicated chat-socket image with legacy compatibility aliases and add otp stepup-up flow in stepup challenge
- Updated dependencies [67ff3ac]
  - @chat/auth@2.3.1

## 4.0.0

### Major Changes

- 8a4de46: Added task management across the stack, including shared task models/types, task APIs and socket events, a real-time task panel in the web app, and an outbox-driven worker for task intelligence and execution.

### Patch Changes

- Updated dependencies [8a4de46]
  - @chat/services@2.0.0
  - @chat/types@1.3.0

## 3.1.0

### Minor Changes

- 2c48736: Add Google OAuth auth-flow reliability fixes in auth and web, including monorepo env loading support, clearer callback failure handling, and improved login fallback behavior

### Patch Changes

- Updated dependencies [2c48736]
  - @chat/auth@2.3.0
