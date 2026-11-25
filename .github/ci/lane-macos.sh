#!/usr/bin/env bash
# Runs multi-node plans on a macOS host, from a workflow or a workstation.
#
#   lane-macos.sh run --ref SHA --harness-ref REF --tests LIST
#                     --exec-suffix SUFFIX [--out DIR]
#   lane-macos.sh cleanup
#
# Both slots run on this machine: under Actions, a hosted macOS runner. The
# lane leases a staging user pool through the same lock objects as the Linux
# lanes, so no other job drives the same users, checks the harness out into
# ~/relay-harness, and runs its node script (scripts/mn-lane-node-macos.sh),
# which writes ~/test-summary.json and ~/test-metadata.json. Their published
# reductions land in DIR. `{pool}` in SUFFIX is replaced by the leased pool.
#
# The repository is public, so its Actions logs are public. The node script's
# stdout and stderr go to a file on this machine; only verdict and progress
# lines are printed.
#
# Runs under the bash 3.2 that macOS ships.
#
# Environment: HARNESS_DEPLOY_KEY, CI_R2_ENDPOINT, CI_R2_BUCKET,
# AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY.
set -uo pipefail

CI_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export CI_R2_BUCKET="${CI_R2_BUCKET:-system3-ci}"
export GITHUB_RUN_ID="${GITHUB_RUN_ID:-local$(date +%s)}"
export GITHUB_RUN_ATTEMPT="${GITHUB_RUN_ATTEMPT:-1}"
export GITHUB_JOB="${GITHUB_JOB:-local}"
if [ -z "${RUNNER_TEMP:-}" ]; then
  RUNNER_TEMP="$(mktemp -d)"
  export RUNNER_TEMP
fi
HARNESS_DIR="$HOME/relay-harness"
DEPLOY_KEY="$RUNNER_TEMP/ci-deploy-key"
PRIVATE_LOG="$RUNNER_TEMP/mn-macos-output.txt"

# shellcheck source=gce-lane.sh
source "$CI_DIR/gce-lane.sh"

# The pool lease shuffles its candidates; macOS has no shuf.
if ! command -v shuf >/dev/null 2>&1; then
  shuf() {
    awk 'BEGIN { srand() } { printf "%f\t%s\n", rand(), $0 }' | sort -n | cut -f2-
  }
fi

# Stops this job's slots, removes its credentials, and frees its pool. The
# pool is released only after its slots are down, so no other job can drive
# staging users a live slot still holds.
cmd_cleanup() {
  [ -z "${LANE_RELEASED:-}" ] || return 0
  if [ -f "$HARNESS_DIR/scripts/mn-lane-node-macos.sh" ] && [ -n "${CI_SLOTS:-}" ]; then
    bash "$HARNESS_DIR/scripts/mn-lane-node-macos.sh" --stop "$CI_SLOTS" >> "$PRIVATE_LOG" 2>&1 \
      || echo "::warning::Could not stop the slots"
  fi
  rm -f "$DEPLOY_KEY"
  ci_lease_release
  ci_export LANE_RELEASED 1
}

OUT_DIR=""
# Writes the results the node script produced (the infra verdict where it
# produced none), reduced to what may be published: OUT_DIR is uploaded as a
# public artifact, so raw results never land in it. Then releases the pool.
finalize() {
  [ -n "$OUT_DIR" ] || return 0
  local raw="$RUNNER_TEMP/macos-raw"
  mkdir -p "$raw"
  [ -s "$raw/summary.json" ] \
    || echo '{"summary":{"total":0,"pass":0,"fail":0},"tests":[],"state":"error"}' > "$raw/summary.json"
  [ -s "$raw/metadata.json" ] \
    || echo '{"reportUrl":"","commit":"","execId":""}' > "$raw/metadata.json"
  if ! node "$CI_DIR/public-summary.js" "$raw/summary.json" "$raw/metadata.json" 2>/dev/null; then
    echo '{"summary":{"total":0,"pass":0,"fail":0},"tests":[],"state":"error"}' > "$raw/summary.json"
    echo '{"reportUrl":"","commit":"","execId":""}' > "$raw/metadata.json"
  fi
  mv "$raw/summary.json" "$raw/metadata.json" "$OUT_DIR/"
  cmd_cleanup
  OUT_DIR=""
}

# Checks the harness out at REF. Its output is harness text and stays in the
# private log.
harness_checkout() {
  local ref="$1"
  printf '%s\n' "$HARNESS_DEPLOY_KEY" > "$DEPLOY_KEY"
  chmod 600 "$DEPLOY_KEY"
  export GIT_SSH_COMMAND="ssh -i $DEPLOY_KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
  if [ ! -d "$HARNESS_DIR/.git" ]; then
    ci_retry 300 "harness clone" git clone --quiet \
      git@github.com:No-Instructions/relay-harness.git "$HARNESS_DIR" >> "$PRIVATE_LOG" 2>&1 || return 1
  fi
  (
    cd "$HARNESS_DIR" || exit 1
    git checkout --quiet -- . && git clean -fdq
    ci_retry 300 "harness fetch" git fetch --quiet origin || exit 1
    git checkout --quiet --detach "origin/${ref#origin/}" 2>/dev/null \
      || git checkout --quiet --detach "$ref"
  ) >> "$PRIVATE_LOG" 2>&1 || return 1
  git -C "$HARNESS_DIR" log -1 --format='harness: %h'
}

cmd_run() {
  local ref="" harness_ref="" tests="" exec_suffix="" out="."
  while [ $# -gt 0 ]; do
    case "$1" in
      --ref) ref="$2" ;;
      --harness-ref) harness_ref="$2" ;;
      --tests) tests="$2" ;;
      --exec-suffix) exec_suffix="$2" ;;
      --out) out="$2" ;;
      *) echo "::error::lane-macos.sh run: unknown option $1"; return 2 ;;
    esac
    shift 2
  done
  local name
  for name in ref harness_ref tests exec_suffix; do
    [ -n "${!name}" ] || { echo "::error::lane-macos.sh run: --${name//_/-} is required"; return 2; }
  done
  for name in HARNESS_DEPLOY_KEY CI_R2_ENDPOINT AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY; do
    [ -n "${!name:-}" ] || { echo "::error::lane-macos.sh: $name must be set"; return 2; }
  done
  [ "$(uname -s)" = Darwin ] || { echo "::error::lane-macos.sh runs on macOS"; return 2; }
  mkdir -p "$out"
  OUT_DIR="$(cd "$out" && pwd)"
  rm -f "$OUT_DIR/summary.json" "$OUT_DIR/metadata.json"
  rm -rf "$RUNNER_TEMP/macos-raw"
  : > "$PRIVATE_LOG"
  trap 'rc=$?; finalize; exit $rc' EXIT
  trap 'exit 130' INT TERM

  echo "== Lease a staging user pool"
  ci_lease_acquire mnm || return 1

  echo "== Check out the harness"
  harness_checkout "$harness_ref" || { echo "::error::harness checkout failed"; return 1; }

  echo "== Run $tests on this host"
  # The report uploader reads its store credentials under these names.
  export CI_R2_ACCESS_KEY_ID="$AWS_ACCESS_KEY_ID"
  export CI_R2_SECRET_ACCESS_KEY="$AWS_SECRET_ACCESS_KEY"
  rm -f "$HOME/test-summary.json" "$HOME/test-metadata.json"
  local run_status=0
  bash "$HARNESS_DIR/scripts/mn-lane-node-macos.sh" \
    "$ref" "$tests" "${exec_suffix//\{pool\}/${CI_POOL:-}}" "$CI_SLOTS" 2>&1 \
    | tee -a "$PRIVATE_LOG" | ci_public_filter
  run_status=${PIPESTATUS[0]}
  echo "Run exited with status $run_status"

  echo "== Collect results"
  mkdir -p "$RUNNER_TEMP/macos-raw"
  cp "$HOME/test-summary.json" "$RUNNER_TEMP/macos-raw/summary.json" 2>/dev/null || true
  cp "$HOME/test-metadata.json" "$RUNNER_TEMP/macos-raw/metadata.json" 2>/dev/null || true
  return "$run_status"
}

case "${1:-}" in
  run) shift; cmd_run "$@" ;;
  cleanup) shift; cmd_cleanup ;;
  *) echo "usage: lane-macos.sh run [options] | lane-macos.sh cleanup" >&2; exit 2 ;;
esac
