#!/usr/bin/env bash
# Deploy the task-worker container on a DigitalOcean VPS over SSH.
#
# Required environment variables:
#   VPS_HOST                - SSH hostname or IP
#   VPS_USER                - SSH username
#   VPS_DEPLOY_PATH         - Remote directory containing docker-compose.task-worker.yml and .env
#   TASK_WORKER_DEPLOY_REF  - ghcr.io/owner/chat-task-worker@sha256:...
#   GHCR_PULL_TOKEN         - Token with read:packages for docker login on the VPS
#
# Optional:
#   VPS_SSH_PORT            - SSH port (default: 22)

set -euo pipefail

: "${VPS_HOST:?VPS_HOST is required}"
: "${VPS_USER:?VPS_USER is required}"
: "${VPS_DEPLOY_PATH:?VPS_DEPLOY_PATH is required}"
: "${TASK_WORKER_DEPLOY_REF:?TASK_WORKER_DEPLOY_REF is required}"
: "${GHCR_PULL_TOKEN:?GHCR_PULL_TOKEN is required}"

SSH_PORT="${VPS_SSH_PORT:-22}"
GHCR_USER="${GHCR_PULL_USER:-${GITHUB_ACTOR:-github-actions}}"
COMPOSE_FILE="deploy/docker-compose.task-worker.yml"

ssh_opts=(
  -o StrictHostKeyChecking=accept-new
  -o BatchMode=yes
  -p "$SSH_PORT"
)

if [[ -n "${VPS_SSH_IDENTITY_FILE:-}" ]]; then
  ssh_opts+=(-i "$VPS_SSH_IDENTITY_FILE")
fi

remote_script="$(cat <<EOF
set -euo pipefail
cd "${VPS_DEPLOY_PATH}"
echo "${GHCR_PULL_TOKEN}" | docker login ghcr.io -u "${GHCR_USER}" --password-stdin
export TASK_WORKER_IMAGE="${TASK_WORKER_DEPLOY_REF}"
docker compose -f "${COMPOSE_FILE}" pull
docker compose -f "${COMPOSE_FILE}" up -d --remove-orphans
docker compose -f "${COMPOSE_FILE}" ps
EOF
)"

echo "Deploying task-worker to ${VPS_USER}@${VPS_HOST}:${VPS_DEPLOY_PATH}"
ssh "${ssh_opts[@]}" "${VPS_USER}@${VPS_HOST}" bash -s <<< "$remote_script"
echo "Task-worker deploy completed."
