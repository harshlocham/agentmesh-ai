---
"@chat/services": patch
"@chat/task-worker": patch
"@chat/socket": patch
"@chat/db": patch
"@chat/web": patch
"chat-app": patch
---

Hardened realtime authorization and internal communication architecture across the platform. Refactored the socket server into a transport-only layer using secure internal web authorization bridges, centralized conversation/task ACL enforcement, server-resolved participant fan-out, and mandatory INTERNAL_SECRET validation. Added shared authorization services for REST and socket flows, removed client-trusted recipient authorization paths, restricted unsafe task status mutations, and improved overall security consistency for realtime messaging and task execution.
