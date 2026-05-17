# @chat/socket

## 3.0.3

### Patch Changes

- 5a2cba8: - Socket: register message:send handlers; broadcast online status on connect; remove duplicate join/leave handlers
  - Web: connect socket after login/register without reload; stop disconnecting on tab visibility changes
  - Mobile: reconnect on app foreground instead of disconnecting in background
  - Task worker: use @chat/services package imports so production start resolves modules correctly
  - Root: Next 15.5.18 override, uuid 14, ESLint config baseDirectory for apps/web

## 3.0.2

### Patch Changes

- 6c57198: Fix socket auth and deployment flow for production by normalizing origins, enabling cross-subdomain auth cookies, and binding the socket server to the Render-injected port.

## 3.0.1

### Patch Changes

- 5fb4167: fix socket production connection issue

## 3.0.0

### Major Changes

- 8a4de46: Added task management across the stack, including shared task models/types, task APIs and socket events, a real-time task panel in the web app, and an outbox-driven worker for task intelligence and execution.

### Patch Changes

- Updated dependencies [8a4de46]
  - @chat/types@1.3.0
