# Release Architecture (Monorepo)

This repository uses a three-stage release pipeline:

1. `CI` validates code quality, unit tests, and build health.
2. `Release` handles versioning and tag orchestration using Changesets.
3. `Deploy` builds container images and deploys all runtime services.

## Multi-Service Deploy Targets

| Service | Platform | Artifact |
|---------|----------|----------|
| Web (Next.js API/UI) | Vercel | Built from source at release commit via Vercel CLI |
| Socket server | Render Web Service | `ghcr.io/{owner}/chat-socket` (immutable digest) |
| Task worker | DigitalOcean VPS | `ghcr.io/{owner}/chat-task-worker` (immutable digest) — **optional**; gated by `ENABLE_TASK_WORKER_DEPLOY` |

Deploy order per environment:

1. Socket on Render
2. Task worker on VPS (when `ENABLE_TASK_WORKER_DEPLOY=true`; requires socket to be reachable)
3. Web on Vercel (last)

## Task Worker Deploy Feature Flag

Task worker deployment is **disabled by default** while the service is still under active development and not part of production infrastructure.

| Variable | Default | Purpose |
|----------|---------|---------|
| `ENABLE_TASK_WORKER_DEPLOY` | unset / not `true` | When set to the string `true`, enables task worker image build, VPS deploy, rollback, and related verification steps |

**When disabled (default):** CI, Release, socket (Render), and web (Vercel) deploys run normally. Task worker jobs and steps are skipped without failing the workflow.

**When enabled:** Set `ENABLE_TASK_WORKER_DEPLOY` to `true` in GitHub repository variables (Settings → Secrets and variables → Actions → Variables). Complete the [DigitalOcean VPS setup](#3-digitalocean-vps-task-worker) below, then redeploy. No workflow code changes are required.

## Workflow Responsibilities

- `node.js.yml` (`CI`)
  - Installs dependencies, builds packages, runs `pnpm run test`, typecheck, lint, full build, and artifact verification.
  - Runs web and socket runtime smoke tests.
  - Acts as the release gate for `main` and `develop`.
- `release.yml` (`Release`)
  - Runs only after successful `CI` on `main`.
  - Uses Changesets to open/maintain release PRs (`version-packages` also syncs root `package.json` via `scripts/ci/sync-root-release-version.mjs`).
  - Creates or resolves one clean semver tag (`vX.Y.Z`) for deployable commits.
  - Creates a GitHub Release and emits `release-metadata.env`.
- `deploy.yml` (`Deploy`)
  - Runs after successful `Release` and supports manual promotions via `workflow_dispatch`.
  - Builds and pushes `chat-socket` image to GHCR (cosign-signed, SBOM + provenance).
  - Builds and pushes `chat-task-worker` image when `ENABLE_TASK_WORKER_DEPLOY=true`.
  - Deploys Render → (optional VPS task worker) → Vercel per environment.
  - For `deploy_target=both`: staging success → production approval gate → production.
  - Advances socket `:latest` tags only after a successful rollout.
  - Auto-dispatches `rollback.yml` when production health checks fail and a previous tag exists.
- `rollback.yml` (`Rollback`)
  - Manual or auto-triggered rollback of socket and web to a prior `v*` tag.
  - Rolls back task worker on VPS when `ENABLE_TASK_WORKER_DEPLOY=true`.
  - Restores socket `:latest` moving tags after success.

## Idempotency Guarantees

- If the same commit is reprocessed by `Release`, existing clean tags are detected and reused.
- If a release tag already exists but points to a different commit, deployment is blocked.
- `Deploy` skips image rebuild when the immutable version tag already exists in GHCR.
- `Deploy` skips environment rollout when that SHA already has a successful GitHub Deployment for that environment.

## Manual Promotion

Use `Deploy` workflow dispatch inputs:

- `release_tag` (optional): semver git tag to deploy (for example, `v1.2.3`); if omitted, latest release tag is used.
- `deploy_target`: `staging` (default), `production`, or `both`.

For active development with no production users, prefer `staging` for manual promotions.

## One-Time Setup Checklist

### 1. Vercel (web)

1. Create a Vercel project linked to this repo (root `vercel.json` configures the monorepo build).
2. Add GitHub repository secrets:
   - `VERCEL_TOKEN`
3. Add GitHub repository variables:
   - `VERCEL_ORG_ID`
   - `VERCEL_PROJECT_ID`
4. Configure environment variables in Vercel (MongoDB, Redis, auth secrets, `NEXT_PUBLIC_SOCKET_URL`, etc.).

### 2. Render (socket)

1. Create a Render Web Service that pulls from GHCR (`ghcr.io/{owner}/chat-socket`).
2. Connect GHCR credentials in Render for private package access.
3. Set runtime env vars (`REDIS_URL`, `WEB_SERVER_URL`, `INTERNAL_SECRET`, `ORIGIN`, etc.).
4. Add GitHub secrets/variables:
   - Secret: `RENDER_API_KEY`
   - Variable: `RENDER_SOCKET_SERVICE_ID` (production)
   - Variable: `RENDER_SOCKET_STAGING_SERVICE_ID` (staging, optional separate service)
   - Variable: `RENDER_SOCKET_HEALTHCHECK_URL` / `RENDER_SOCKET_STAGING_HEALTHCHECK_URL` (optional)

### 3. DigitalOcean VPS (task worker)

Required only when `ENABLE_TASK_WORKER_DEPLOY=true`.
1. Provision a VPS with Docker and Docker Compose.
2. Create deploy directory (for example `/opt/chat-app`) containing:
   - `deploy/docker-compose.task-worker.yml` (from this repo)
   - `.env` with worker secrets (not committed)
3. Add the VPS user's SSH public key or configure deploy key access.
4. Add GitHub secrets/variables:
   - Secret: `VPS_SSH_PRIVATE_KEY`
   - Secret: `GHCR_PULL_TOKEN` (PAT with `read:packages`, if images are private)
   - Variable: `VPS_HOST`, `VPS_USER`, `VPS_DEPLOY_PATH`
   - Optional staging overrides: `VPS_STAGING_HOST`, `VPS_STAGING_DEPLOY_PATH`

### 4. GitHub Environments

Create `staging` and `production` environments in repository settings. Configure required reviewers on `production` when ready for go-live.

### 5. First deploy

1. Merge a Changesets Version PR so `Release` creates a `v*` tag.
2. Run `Deploy` manually with `deploy_target=staging` to validate socket and web deploys (and task worker when enabled).
3. When ready, use `deploy_target=both` or `production` for production promotion.

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
deploy/
  docker-compose.task-worker.yml
scripts/
  ci/
    verify-artifacts.sh
    sync-root-release-version.mjs
    deploy/
      vercel.sh
      render-socket.sh
      vps-task-worker.sh
docker/
  socket.Dockerfile
apps/task-worker/Dockerfile
```

## Release Metadata Contract

`release-metadata.env`:

- `RELEASE_SHA`: full commit SHA
- `RELEASE_SHORT_SHA`: short commit SHA
- `DEPLOYABLE`: `true` or `false`
- `RELEASE_TAG`: git tag (`vX.Y.Z`)
- `RELEASE_VERSION`: semver without `v`

## GitHub Secrets And Variables

### Secrets

| Secret | Used for |
|--------|----------|
| `VERCEL_TOKEN` | Vercel CLI deploy |
| `RENDER_API_KEY` | Render deploy API |
| `VPS_SSH_PRIVATE_KEY` | SSH to DigitalOcean VPS (task worker; only when `ENABLE_TASK_WORKER_DEPLOY=true`) |
| `GHCR_PULL_TOKEN` | VPS `docker login` when GHCR images are private (task worker; falls back to `GITHUB_TOKEN` in workflow) |
| `SLACK_WEBHOOK_URL` | Release notifications (optional) |
| `DISCORD_WEBHOOK_URL` | Release notifications (optional) |

### Variables

| Variable | Purpose |
|----------|---------|
| `ENABLE_TASK_WORKER_DEPLOY` | Set to `true` to enable task worker image build, VPS deploy, and rollback (default: disabled) |
| `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` | Vercel CLI target |
| `RENDER_SOCKET_SERVICE_ID` | Production Render socket service ID |
| `RENDER_SOCKET_STAGING_SERVICE_ID` | Staging Render socket service ID |
| `RENDER_SOCKET_HEALTHCHECK_URL` | Production socket health endpoint |
| `RENDER_SOCKET_STAGING_HEALTHCHECK_URL` | Staging socket health endpoint |
| `VPS_HOST`, `VPS_USER`, `VPS_DEPLOY_PATH` | Production VPS SSH target (task worker; only when `ENABLE_TASK_WORKER_DEPLOY=true`) |
| `VPS_STAGING_HOST`, `VPS_STAGING_DEPLOY_PATH` | Optional staging VPS overrides (task worker) |
| `STAGING_APP_URL`, `PRODUCTION_APP_URL` | Deployment URLs in GitHub Deployments |
| `STAGING_HEALTHCHECK_URL`, `PRODUCTION_HEALTHCHECK_URL` | Web health checks after deploy |
