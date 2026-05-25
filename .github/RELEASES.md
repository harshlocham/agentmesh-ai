# Release Architecture (Monorepo)

This repository uses a three-stage release pipeline:

1. `CI` validates code quality and build health.
2. `Release` handles versioning and tag orchestration using Changesets.
3. `Deploy` performs deterministic image build/push and environment deployment.

## Workflow Responsibilities

- `node.js.yml` (`CI`)
  - Runs checks, tests, and builds.
  - Acts as the release gate.
- `release.yml` (`Release`)
  - Runs only after successful `CI` on `main`.
  - Uses Changesets to open/maintain release PRs.
  - Creates or resolves one clean semver tag (`vX.Y.Z`) for deployable commits.
  - Emits `release-metadata.env` artifact (`RELEASE_TAG`, `RELEASE_VERSION`, `RELEASE_SHA`).
- `deploy.yml` (`Deploy`)
  - Runs after successful `Release` and also supports manual promotions via `workflow_dispatch`.
  - Verifies metadata and tag integrity.
  - Builds and pushes the dedicated `chat-socket` image tags, updates `latest`, and publishes legacy `chat-services` aliases for compatibility.
  - Deploys to `staging` and/or `production` based on promotion target.
  - For `deploy_target=both`, enforces strict sequence: staging success -> explicit promotion approval -> production.
  - Uses GitHub Deployments API checks to prevent redeploying the same commit to the same environment.
  - Triggers rollback workflow automatically when production health checks fail and a previous tag exists.
  - Sends release notifications (Slack/Discord) with tag/version/sha and links to workflow + release.

## Idempotency Guarantees

- If the same commit is reprocessed by `Release`, existing clean tags are detected and reused.
- If a release tag already exists but points to a different commit, deployment is blocked.
- `Deploy` checks existing successful deployments per environment and SHA:
  - if already successful, the environment deploy is skipped;
  - if not, deployment proceeds and records success status.

## Manual Promotion

Use `Deploy` workflow dispatch inputs:

- `release_tag` (optional): semver git tag to deploy (for example, `v1.2.3`); if omitted, latest release tag is used.
- `deploy_target`: `staging`, `production`, or `both`.

This allows controlled promotions without creating a new release.
For `deploy_target=both`, configure required reviewers on the `production` environment to require explicit approval between staging and production.

## Recommended CI/CD Folder Structure

```
.github/
  workflows/
    node.js.yml
    release.yml
    deploy.yml
    rollback.yml
    security.yml
  RELEASES.md
.changeset/
  config.json
  README.md
scripts/
  ci/
    verify-artifacts.sh
docker/
  socket.Dockerfile
```

## Release Metadata Contract

`release-metadata.env`:

- `RELEASE_SHA`: full commit SHA
- `RELEASE_SHORT_SHA`: short commit SHA
- `DEPLOYABLE`: `true` or `false`
- `RELEASE_TAG`: git tag (`vX.Y.Z`)
- `RELEASE_VERSION`: semver without `v`

## Optional Config For Health Checks And Notifications

GitHub repository settings:

- Variables:
  - `STAGING_APP_URL`
  - `PRODUCTION_APP_URL`
  - `STAGING_HEALTHCHECK_URL`
  - `PRODUCTION_HEALTHCHECK_URL`
- Secrets:
  - `SLACK_WEBHOOK_URL`
  - `DISCORD_WEBHOOK_URL`
