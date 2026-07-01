#!/usr/bin/env bash
# Roll back the Vercel production deployment to the previous release.
#
# Required environment variables:
#   VERCEL_TOKEN        - Vercel API token
#   VERCEL_ORG_ID       - Vercel team/org ID
#   VERCEL_PROJECT_ID   - Vercel project ID

set -euo pipefail

: "${VERCEL_TOKEN:?VERCEL_TOKEN is required}"
: "${VERCEL_ORG_ID:?VERCEL_ORG_ID is required}"
: "${VERCEL_PROJECT_ID:?VERCEL_PROJECT_ID is required}"

export VERCEL_ORG_ID
export VERCEL_PROJECT_ID

echo "Rolling back Vercel production deployment"
npx --yes vercel@latest rollback --yes --token="$VERCEL_TOKEN"
echo "Vercel rollback completed."
