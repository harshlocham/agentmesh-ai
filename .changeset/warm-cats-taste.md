---
"@chat/task-worker": patch
"mobile": patch
"@chat/socket": patch
"@chat/web": patch
"chat-app": patch
---

- Socket: register message:send handlers; broadcast online status on connect; remove duplicate join/leave handlers
- Web: connect socket after login/register without reload; stop disconnecting on tab visibility changes
- Mobile: reconnect on app foreground instead of disconnecting in background
- Task worker: use @chat/services package imports so production start resolves modules correctly
- Root: Next 15.5.18 override, uuid 14, ESLint config baseDirectory for apps/web
