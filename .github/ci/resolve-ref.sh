#!/usr/bin/env bash
# Prints the product commit SHA a ref names: a branch (origin/ prefix
# optional), a tag, or a SHA. Resolves through the GitHub API, so it needs
# `gh` authenticated (GH_TOKEN in a workflow).
#
#   resolve-ref.sh REF
set -euo pipefail
ref="${1:?usage: resolve-ref.sh REF}"
repo="${GITHUB_REPOSITORY:-No-Instructions/Relay}"
api_ref="${ref#origin/}"
api_ref="${api_ref#refs/heads/}"
api_ref="${api_ref#refs/tags/}"
encoded=$(jq -rn --arg ref "$api_ref" '$ref | @uri')
for attempt in 1 2 3 4 5; do
  if sha=$(gh api "repos/$repo/commits/$encoded" --jq .sha 2>/dev/null) && [ -n "$sha" ]; then
    echo "$sha"
    exit 0
  fi
  sleep $((attempt * 3))
done
echo "::error::Could not resolve $ref" >&2
exit 1
