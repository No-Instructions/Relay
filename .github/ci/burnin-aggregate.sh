#!/usr/bin/env bash
# Appends a burn-in run's per-plan verdicts to the persistent ledger at
# s3://$CI_R2_BUCKET/burnin/ledger.jsonl, which accumulates flake rates across
# nights. Reads the legs' results from github-runs/<run id>/attempt-<n>/burnin/.
#
# Environment: GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT, PRODUCT_SHA, SOAK_REF,
# CI_R2_ENDPOINT, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY,
# CI_R2_BUCKET (default system3-ci).
set -euo pipefail
CI_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-auto}" AWS_EC2_METADATA_DISABLED=true
bucket="${CI_R2_BUCKET:-system3-ci}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
s3api() { aws s3api --endpoint-url "$CI_R2_ENDPOINT" --no-cli-pager "$@"; }

aws s3 cp "s3://$bucket/github-runs/$GITHUB_RUN_ID/attempt-$GITHUB_RUN_ATTEMPT/burnin/" \
  "$work/results/" --recursive --endpoint-url "$CI_R2_ENDPOINT" --only-show-errors || true

# S3 has no append, so this reads, modifies and writes the ledger. Only a
# ledger that does not exist starts fresh: any other read error stops here,
# because writing back an empty ledger would erase the flake history.
if ! err=$(s3api get-object --bucket "$bucket" --key burnin/ledger.jsonl "$work/ledger.jsonl" 2>&1 >/dev/null); then
  if echo "$err" | grep -q "NoSuchKey"; then
    echo "No existing ledger; starting fresh"
    : > "$work/ledger.jsonl"
  else
    echo "$err"
    echo "::error::Could not read the burn-in ledger; leaving it unchanged"
    exit 1
  fi
else
  echo "Fetched existing ledger ($(wc -l < "$work/ledger.jsonl") rows)"
fi

node "$CI_DIR/burnin-ledger.js" "$work/results" "$work/ledger.jsonl"

s3api put-object --bucket "$bucket" --key burnin/ledger.jsonl \
  --body "$work/ledger.jsonl" \
  --content-type application/x-ndjson \
  --cache-control 'no-cache, must-revalidate' >/dev/null
echo "Pushed ledger ($(wc -l < "$work/ledger.jsonl") rows) to s3://$bucket/burnin/ledger.jsonl"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  printf '## E2E burn-in\n\n[Report](https://ci.system3.dev/burnin/ledger.jsonl)\n' >> "$GITHUB_STEP_SUMMARY"
fi
