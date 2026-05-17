# @chat/task-worker

## 2.0.4

### Patch Changes

- 5a2cba8: - Socket: register message:send handlers; broadcast online status on connect; remove duplicate join/leave handlers
  - Web: connect socket after login/register without reload; stop disconnecting on tab visibility changes
  - Mobile: reconnect on app foreground instead of disconnecting in background
  - Task worker: use @chat/services package imports so production start resolves modules correctly
  - Root: Next 15.5.18 override, uuid 14, ESLint config baseDirectory for apps/web

## 2.0.3

### Patch Changes

- 8e3ed9a: Introduce LLM provider abstraction: pluggable providers, shared interfaces, and cleaner configuration.

## 2.0.2

### Patch Changes

- dc73990: task-worker: unify LLM boundary, preserve step IO, add self-heal and clarification flows; redact policy decisions and improve execution updates
- Updated dependencies [dc73990]
  - @chat/types@1.3.2

## 2.0.1

### Patch Changes

- e3ad385: The system has been fully implemented to support multi-step execution with strict safety and hallucination prevention.d it can self-heal a failed tool execution by asking the LLM for a corrected decision before falling back to normal retry behavior. The planner now preserves step input/output from LLM plans and explicitly asks for template-ready step context
- Updated dependencies [e3ad385]
  - @chat/services@2.0.1
  - @chat/types@1.3.1
  - @chat/db@2.0.2

## 2.0.0

### Major Changes

- 8a4de46: Added task management across the stack, including shared task models/types, task APIs and socket events, a real-time task panel in the web app, and an outbox-driven worker for task intelligence and execution.

### Patch Changes

- Updated dependencies [8a4de46]
  - @chat/services@2.0.0
  - @chat/db@2.0.0
  - @chat/types@1.3.0
