#!/bin/bash
# Build image staging từ một git ref sạch (tag/commit), không dùng working tree.
#   integrations/openclaw/scripts/build-staging-api.sh [git-ref]
set -euo pipefail
REF="${1:-sales-release-20261005}"
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
CTX="/opt/kido-recruiter/build/sales-api"
SHA="$(git -C "$REPO" rev-parse --verify "$REF^{commit}")"

rm -rf "$CTX" && mkdir -p "$CTX"
git -C "$REPO" archive --format=tar "$SHA" | tar -x -C "$CTX"
echo "Building kido-sales-staging:$REF from $SHA"
docker build \
  --label "org.opencontainers.image.revision=$SHA" \
  --label "org.opencontainers.image.version=$REF" \
  -t "kido-sales-staging:$REF" \
  -f "$REPO/integrations/openclaw/staging/Dockerfile" \
  "$CTX"
