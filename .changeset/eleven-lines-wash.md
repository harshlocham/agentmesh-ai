---
"@chat/services": patch
"@chat/task-worker": patch
---

- Introduced markOutboxEventDeferred function to handle event deferral in case of execution lease conflicts.
- Updated task processing logic to defer events when an ExecutionLeaseBusyError occurs.
- Enhanced outbox function retrieval to include the new defer functionality.
- Removed unnecessary runId references in agent-runner for improved idempotency.
- Added tests to verify the behavior of event deferral and its impact on claim attempts.
