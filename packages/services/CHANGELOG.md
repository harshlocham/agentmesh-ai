# @chat/services

## 2.0.3

### Patch Changes

- 072fafc: - Introduced markOutboxEventDeferred function to handle event deferral in case of execution lease conflicts.
  - Updated task processing logic to defer events when an ExecutionLeaseBusyError occurs.
  - Enhanced outbox function retrieval to include the new defer functionality.
  - Removed unnecessary runId references in agent-runner for improved idempotency.
  - Added tests to verify the behavior of event deferral and its impact on claim attempts.
- 4a29cb5: Enhance execution lease management and task processing.
  - Added execution lease validation before task processing begins.
  - Improved handling of lease contention with a dedicated execution lease busy error.
  - Refined task action ID generation for more consistent task tracking.
  - Cleaned up task-related API code and removed unused imports.

## 2.0.2

### Patch Changes

- 51f6a45: Hardened realtime authorization and internal communication architecture across the platform. Refactored the socket server into a transport-only layer using secure internal web authorization bridges, centralized conversation/task ACL enforcement, server-resolved participant fan-out, and mandatory INTERNAL_SECRET validation. Added shared authorization services for REST and socket flows, removed client-trusted recipient authorization paths, restricted unsafe task status mutations, and improved overall security consistency for realtime messaging and task execution.
- Updated dependencies [51f6a45]
  - @chat/db@2.0.3

## 2.0.1

### Patch Changes

- e3ad385: The system has been fully implemented to support multi-step execution with strict safety and hallucination prevention.d it can self-heal a failed tool execution by asking the LLM for a corrected decision before falling back to normal retry behavior. The planner now preserves step input/output from LLM plans and explicitly asks for template-ready step context
- Updated dependencies [e3ad385]
  - @chat/types@1.3.1
  - @chat/db@2.0.2

## 2.0.0

### Major Changes

- 8a4de46: Added task management across the stack, including shared task models/types, task APIs and socket events, a real-time task panel in the web app, and an outbox-driven worker for task intelligence and execution.

### Patch Changes

- Updated dependencies [8a4de46]
  - @chat/db@2.0.0
  - @chat/types@1.3.0

## 1.1.0

### Minor Changes

- 3215a80: Enhanced mobile authentication and chat session management, and standardized monorepo build tooling across shared packages.
  - Added mobile auth support improvements and session flow hardening.
  - Added explicit build scripts/config for shared packages (auth, db, services, redis, types) to emit dist artifacts consistently.
  - Improved repository cleanup scripts with safer artifact cleanup and full-reset options.
  - Updated Turbo build outputs for better Next.js build caching behavior.

### Patch Changes

- Updated dependencies [3215a80]
  - @chat/types@1.1.0

## 1.0.3

### Patch Changes

- 86f8cfe: Refactor CI/CD to use Changesets-native package tags for deployment
  - Removed root `v*` tag creation logic from release workflow
  - Updated deploy workflow to trigger on Changesets tags (`@chat/services@*`)
  - Implemented strict tag parsing and validation
  - Added package-specific deployment gating
  - Improved Docker tagging and metadata extraction
  - Enforced PAT usage for reliable workflow chaining

- Updated dependencies [86f8cfe]
  - @chat/types@1.0.3

## 1.0.2

### Patch Changes

- 86f8cfe: Fix release workflow to create root version tags for deploy trigger
  - **release.yml**: Add step to create root repository version tag (v\*) based on highest package version
  - **deploy.yml compatibility**: Root v\* tags now enable proper deployment workflow triggering
  - This resolves the issue where release workflow created only package-scoped tags but deploy workflow needed root tags

- Updated dependencies [86f8cfe]
  - @chat/types@1.0.2

## 1.0.1

### Patch Changes

- 3b307d2: Fix CI/CD release and deployment pipeline configuration
  - **release.yml**: Fix publish step to actually create git tags using `npx changeset tag` instead of echo fallback
  - **release.yml**: Add robust token fallback (`CHANGESETS_GITHUB_TOKEN || GITHUB_TOKEN`) for private repo releases
  - **deploy.yml**: Relax actor gate to allow repository owner to trigger deployments from token-based releases
  - **deploy.yml**: Add comprehensive deployment provenance validation (semver format, commit ancestry, GitHub Release verification)
  - **deploy.yml**: Add timeout configurations and improve error handling for staging/production builds

  These fixes ensure the automated release pipeline correctly creates version tags and the deployment workflow is properly triggered, enabling end-to-end CI/CD automation for the monorepo.

- Updated dependencies [3b307d2]
  - @chat/types@1.0.1
