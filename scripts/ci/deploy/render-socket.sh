#!/usr/bin/env bash
# Deploy the socket service on Render using an immutable image reference.
#
# Required environment variables:
#   RENDER_API_KEY          - Render API bearer token
#   RENDER_SOCKET_SERVICE_ID - Target Render service ID
#   SOCKET_DEPLOY_REF       - ghcr.io/owner/chat-socket@sha256:...

set -euo pipefail

: "${RENDER_API_KEY:?RENDER_API_KEY is required}"
: "${RENDER_SOCKET_SERVICE_ID:?RENDER_SOCKET_SERVICE_ID is required}"
: "${SOCKET_DEPLOY_REF:?SOCKET_DEPLOY_REF is required}"

payload="$(jq -n --arg imageUrl "$SOCKET_DEPLOY_REF" '{ imageUrl: $imageUrl }')"

echo "Triggering Render deploy for service ${RENDER_SOCKET_SERVICE_ID}"
echo "Image: ${SOCKET_DEPLOY_REF}"

response="$(curl -sS -w "\n%{http_code}" -X POST \
  "https://api.render.com/v1/services/${RENDER_SOCKET_SERVICE_ID}/deploys" \
  -H "Authorization: Bearer ${RENDER_API_KEY}" \
  -H "Content-Type: application/json" \
  -d "$payload")"

http_code="$(echo "$response" | tail -n1)"
body="$(echo "$response" | sed '$d')"

if [[ "$http_code" -lt 200 || "$http_code" -ge 300 ]]; then
  echo "::error::Render deploy API failed (HTTP ${http_code}): ${body}"
  exit 1
fi

echo "Render deploy triggered successfully."
echo "$body" | jq . 2>/dev/null || echo "$body"
