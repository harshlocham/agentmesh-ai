#!/usr/bin/env bash
# Build and deploy the Next.js web app to Vercel from a pinned release commit.
#
# Required environment variables:
#   VERCEL_TOKEN        - Vercel API token
#   VERCEL_ORG_ID       - Vercel team/org ID
#   VERCEL_PROJECT_ID   - Vercel project ID
#   DEPLOY_ENVIRONMENT  - "staging" or "production"
#
# Optional:
#   RELEASE_SHA         - Git commit being deployed (for logging)

set -euo pipefail

: "${VERCEL_TOKEN:?VERCEL_TOKEN is required}"
: "${VERCEL_ORG_ID:?VERCEL_ORG_ID is required}"
: "${VERCEL_PROJECT_ID:?VERCEL_PROJECT_ID is required}"
: "${DEPLOY_ENVIRONMENT:?DEPLOY_ENVIRONMENT is required (staging or production)}"

export VERCEL_ORG_ID
export VERCEL_PROJECT_ID

case "$DEPLOY_ENVIRONMENT" in
  staging)
    vercel_env="preview"
    deploy_args=()
    ;;
  production)
    vercel_env="production"
    deploy_args=(--prod)
    ;;
  *)
    echo "::error::DEPLOY_ENVIRONMENT must be staging or production (got: ${DEPLOY_ENVIRONMENT})"
    exit 1
    ;;
esac

echo "Deploying web to Vercel (${DEPLOY_ENVIRONMENT} / ${vercel_env})"
if [[ -n "${RELEASE_SHA:-}" ]]; then
  echo "Release commit: ${RELEASE_SHA}"
fi

corepack enable
pnpm install --frozen-lockfile

npx --yes vercel@latest pull --yes --environment="$vercel_env" --token="$VERCEL_TOKEN"
npx --yes vercel@latest build --token="$VERCEL_TOKEN"
npx --yes vercel@latest deploy --prebuilt "${deploy_args[@]}" --token="$VERCEL_TOKEN"

echo "Vercel deploy completed for ${DEPLOY_ENVIRONMENT}."
