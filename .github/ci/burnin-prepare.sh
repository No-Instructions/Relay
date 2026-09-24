#!/usr/bin/env bash
# Pins a burn-in run: resolves the product ref and the suite (relay-harness)
# ref to commits, and the plan set to a matrix of plan ids. Prints the
# results, and under Actions sets the step outputs product_sha, ref,
# suite_sha and matrix.
#
#   burnin-prepare.sh [--ref REF] [--tests default|LIST] [--harness-ref REF]
#
# `default` expands to the plans the suite manifest flags burnIn. The legs
# check out suite_sha, never a branch name, so the plans that run are the
# plans that were selected even if the suite advances mid-run.
#
# Environment: HARNESS_DEPLOY_KEY (optional; without it, git uses your own
# SSH access to relay-harness), GH_TOKEN under Actions.
set -euo pipefail
CI_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ref="origin/main" tests="default" harness_ref="origin/main"
while [ $# -gt 0 ]; do
  case "$1" in
    --ref) ref="${2:-origin/main}" ;;
    --tests) tests="${2:-default}" ;;
    --harness-ref) harness_ref="${2:-origin/main}" ;;
    *) echo "::error::burnin-prepare.sh: unknown option $1"; exit 2 ;;
  esac
  shift 2
done

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
if [ -n "${HARNESS_DEPLOY_KEY:-}" ]; then
  printf '%s\n' "$HARNESS_DEPLOY_KEY" > "$work/key"
  chmod 600 "$work/key"
  cat > "$work/hosts" << 'HOSTS'
github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl
github.com ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEmKSENjQEezOmxkZMy7opKgwFB9nkt5YRrYMjNuG5N87uRgg6CLrbo5wAdT/y6v0mKV0U2w0WZ2YB/++Tpockg=
github.com ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQCj7ndNxQowgcQnjshcLrqPEiiphnt+VTTvDP6mHBL9j1aNUkY4Ue1gvwnGLVlOhGeYrnZaMgRK6+PKCUXaDbC7qtbW8gIkhL7aGCsOr/C56SJMy/BCZfxd1nWzAOxSDPgVsmerOBYfNqltV9/hWCqBywINIR+5dIg6JTJ72pcEpEjcYgXkE2YEFXV1JHnsKgbLWNlhScqb2UmyRkQyytRLtL+38TGxkxCflmO+5Z8CSSNY7GidjMIZ7Q4zMjA2n1nGrlTDkzwDCsw+wqFPGQA179cnfGWOWRVruj16z6XyvxvjJwbz0wQZ75XK5tKSb7FNyeIEs4TT4jk+S4dhPeAUC5y+bDYirYgM4GC7uEnztnZyaVWQ7B381AK4Qdrwt51ZqExKbQpTUNn+EjqoTwvqNj4kqx5QUCI0ThS/YkOxJCXmPUWZbhjpCg56i+2aB6CmK2JGhn57K5mj0MNdBXA4/WnwH6XoPWJzK5Nyu2zB3nAZp+S5hpQs+p1vN1/wsjk=
HOSTS
  export GIT_SSH_COMMAND="ssh -i $work/key -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$work/hosts"
fi

# Blobless, shallow, no checkout: one commit's trees, then the single
# manifest blob on demand.
suite="$work/suite"
git clone --quiet --depth=1 --filter=blob:none --no-checkout \
  git@github.com:No-Instructions/relay-harness.git "$suite" \
  || { echo "::error::Could not reach the suite repository"; exit 1; }
git -C "$suite" fetch --quiet --depth=1 origin "${harness_ref#origin/}" \
  || { echo "::error::Could not fetch suite ref $harness_ref"; exit 1; }
suite_sha=$(git -C "$suite" rev-parse FETCH_HEAD)
echo "Resolved suite ref $harness_ref to $suite_sha" >&2

manifest="$work/manifest.json"
git -C "$suite" show "FETCH_HEAD:test-plans/scripts/manifest.json" > "$manifest" 2>/dev/null \
  || : > "$manifest"

# Only the bare token expands; an explicit list passes through verbatim.
if [ "$tests" = default ]; then
  [ -s "$manifest" ] \
    || { echo "::error::Suite manifest is missing at $harness_ref ($suite_sha)"; exit 1; }
  tests=$(jq -r '[.tests[] | select(.burnIn == true) | .id] | join(",")' "$manifest") \
    || { echo "::error::Could not parse the suite manifest at $suite_sha"; exit 1; }
  # No fallback list: an unreadable or empty manifest fails the run rather
  # than guessing at membership.
  [ -n "$tests" ] || { echo "::error::The suite manifest at $suite_sha flags no plans for burn-in"; exit 1; }
  echo "Suite manifest $suite_sha resolves 'default' to: $tests" >&2
fi

# Plans whose red has an open, known cause (manifest burnInExpectedRed). The
# map names plans and causes, so it goes to the private report store beside
# the legs' results, where burnin-aggregate.sh reads it, and never to the log.
expected_red="$work/expected-red.json"
jq -c '[.tests[]? | select(.burnInExpectedRed | type == "string") | {key: .id, value: .burnInExpectedRed}] | from_entries' \
  "$manifest" > "$expected_red" 2>/dev/null || echo '{}' > "$expected_red"
if [ -n "${CI_R2_ENDPOINT:-}" ] && [ -n "${GITHUB_RUN_ID:-}" ]; then
  AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-auto}" AWS_EC2_METADATA_DISABLED=true \
    aws s3 cp "$expected_red" \
    "s3://${CI_R2_BUCKET:-system3-ci}/github-runs/$GITHUB_RUN_ID/attempt-${GITHUB_RUN_ATTEMPT:-1}/burnin/expected-red.json" \
    --endpoint-url "$CI_R2_ENDPOINT" --only-show-errors
fi
echo "Plans with an expected red: $(jq 'length' "$expected_red")" >&2

product_sha=$("$CI_DIR/resolve-ref.sh" "$ref")
echo "Resolved $ref to $product_sha" >&2
matrix=$(echo "$tests" | tr ',' '\n' | sed 's/[[:space:]]//g' | sed '/^$/d' | jq -R . | jq -cs .)

{
  echo "product_sha=$product_sha"
  echo "ref=$ref"
  echo "suite_sha=$suite_sha"
  echo "matrix=$matrix"
} | tee -a "${GITHUB_OUTPUT:-/dev/null}"
