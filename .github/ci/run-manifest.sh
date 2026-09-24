#!/usr/bin/env bash
# Resolves a dispatched run's product ref and records the run manifest in the
# report store at github-runs/<run id>/manifest.json, where relay-ci finds a
# run's report before the run finishes. Prints the product SHA, and under
# Actions also sets the step output product_sha.
#
#   run-manifest.sh --ref REF --tests LIST [--harness-ref REF] [--profile-flags F]
#
# Environment: GH_TOKEN, CI_R2_ENDPOINT, AWS_ACCESS_KEY_ID,
# AWS_SECRET_ACCESS_KEY, CI_R2_BUCKET (default system3-ci).
set -euo pipefail
CI_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ref="" tests="" harness_ref="" profile_flags=""
while [ $# -gt 0 ]; do
  case "$1" in
    --ref) ref="$2" ;;
    --tests) tests="$2" ;;
    --harness-ref) harness_ref="$2" ;;
    --profile-flags) profile_flags="$2" ;;
    *) echo "::error::run-manifest.sh: unknown option $1"; exit 2 ;;
  esac
  shift 2
done
[ -n "$ref" ] || { echo "::error::run-manifest.sh: --ref is required"; exit 2; }
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-auto}" AWS_EC2_METADATA_DISABLED=true
bucket="${CI_R2_BUCKET:-system3-ci}"

product_sha=$("$CI_DIR/resolve-ref.sh" "$ref")
echo "Resolved $ref to $product_sha" >&2
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  echo "product_sha=$product_sha" >> "$GITHUB_OUTPUT"
fi

key="github-runs/${GITHUB_RUN_ID}/manifest.json"
manifest="$(mktemp)"
jq -n \
  --arg githubRunId "$GITHUB_RUN_ID" \
  --arg runNumber "$GITHUB_RUN_NUMBER" \
  --arg runAttempt "$GITHUB_RUN_ATTEMPT" \
  --arg workflow "$GITHUB_WORKFLOW" \
  --arg workflowRef "$GITHUB_REF" \
  --arg workflowSha "$GITHUB_SHA" \
  --arg event "$GITHUB_EVENT_NAME" \
  --arg ref "$ref" \
  --arg productSha "$product_sha" \
  --arg tests "$tests" \
  --arg harnessRef "$harness_ref" \
  --arg profileFlags "$profile_flags" \
  --arg objectKey "$key" \
  '{
    schema: 1,
    githubRunId: $githubRunId,
    runNumber: ($runNumber | tonumber),
    runAttempt: ($runAttempt | tonumber),
    workflow: $workflow,
    workflowRef: $workflowRef,
    workflowSha: $workflowSha,
    event: $event,
    inputs: {
      ref: $ref,
      productSha: $productSha,
      tests: $tests,
      harnessRef: $harnessRef,
      profileFlags: $profileFlags
    },
    report: {
      commit: $productSha,
      execSuffix: ("-r" + $runNumber)
    },
    objectKey: $objectKey
  }' > "$manifest"

aws s3api put-object \
  --endpoint-url "$CI_R2_ENDPOINT" \
  --bucket "$bucket" \
  --key "$key" \
  --body "$manifest" \
  --content-type application/json \
  --cache-control 'no-cache, must-revalidate' \
  --no-cli-pager >/dev/null
rm -f "$manifest"
echo "Uploaded s3://$bucket/$key" >&2
echo "$product_sha"
