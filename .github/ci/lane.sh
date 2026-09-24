#!/usr/bin/env bash
# Runs one CI job on a GCE VM, from a workflow or a workstation.
#
#   lane.sh run --lane LANE --ref REF --harness-ref REF [--suite SUITE]
#               [--vm NAME] [--tests LIST] [--exec-suffix SUFFIX]
#               [--free-slots LIST] [--profile-flags FLAGS]
#               [--obsidian-version V] [--obsidian-url URL]
#               [--out DIR] [--publish-prefix R2_PREFIX]
#   lane.sh cleanup
#
# Two kinds of VM:
#   pool   (--lane bi|tt|mn, no --vm): leases a staging-user pool, creates a
#          VM for this job, and deletes it and releases the pool afterwards.
#          {pool} in --exec-suffix becomes the leased pool (p1..p8).
#   fixed  (--vm NAME): starts a persistent VM (creating it with the harness
#          infra script if it does not exist), and afterwards removes the
#          credentials from it and stops it. The workflow's concurrency group
#          keeps two jobs off one fixed VM.
#
# Suites: scripted (remote-suite.sh, the default), multinode
# (remote-multinode.sh, the default for --lane mn) and unit (remote-unit.sh).
#
# `run` writes DIR/summary.json and DIR/metadata.json, reduced to what may be
# published (public-summary.js), and exits with the suite's status. `cleanup`
# finishes the release of an earlier `run` cut short by a cancelled workflow;
# it reads the state `run` exports through $GITHUB_ENV.
#
# Environment:
#   HARNESS_DEPLOY_KEY      read key for relay-harness (required)
#   CI_R2_ENDPOINT, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
#                           report store credentials (required)
#   CI_SA_KEY               service-account key for the VM (optional)
#   RELAY_GIT_CRYPT_KEY_B64 git-crypt key, base64 (required for --suite unit)
#   GCP_PROJECT, VM_ZONE, VM_IMAGE_FAMILY, CI_R2_BUCKET
#                           defaults below
# gcloud must already be authenticated (the workflow's auth step, or your
# own login on a workstation).
set -uo pipefail

CI_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

export GCP_PROJECT="${GCP_PROJECT:-tactile-timer-426817-t6}"
export VM_ZONE="${VM_ZONE:-us-west2-a}"
export VM_IMAGE_FAMILY="${VM_IMAGE_FAMILY:-relay-e2e-base}"
export CI_R2_BUCKET="${CI_R2_BUCKET:-system3-ci}"
# Outside Actions, stand in for the run identity the lease and VM name use.
export GITHUB_RUN_ID="${GITHUB_RUN_ID:-local$(date +%s)}"
export GITHUB_RUN_ATTEMPT="${GITHUB_RUN_ATTEMPT:-1}"
export GITHUB_JOB="${GITHUB_JOB:-$(whoami)}"
if [ -z "${RUNNER_TEMP:-}" ]; then
  RUNNER_TEMP="$(mktemp -d)"
  export RUNNER_TEMP
fi

# shellcheck source=gce-lane.sh
source "$CI_DIR/gce-lane.sh"

group() {
  if [ -n "${GITHUB_ACTIONS:-}" ]; then
    echo "::endgroup::"
    echo "::group::$1"
  else
    echo "== $1"
  fi
}

die() {
  echo "::error::$*"
  exit 2
}

require_env() {
  local name
  for name in "$@"; do
    [ -n "${!name:-}" ] || die "lane.sh: $name must be set"
  done
}

INFRA_SUMMARY='{"summary":{"total":0,"pass":0,"fail":0},"tests":[],"state":"error"}'
INFRA_METADATA='{"reportUrl":"","commit":"","execId":""}'

# stage_result NAME SOURCE: reduces SOURCE (results fetched from the VM, or
# nothing) to what may be published and writes it to $LANE_OUT_DIR/NAME.
# Only reduced files ever land in the output directory, which the workflow
# uploads as a public artifact; if the reduction fails, the infra verdict
# stands in.
stage_result() {
  local name="$1" source="$2" staged="$RUNNER_TEMP/staged-$1"
  local fallback="$INFRA_SUMMARY" reducer_args
  [ "$name" = metadata.json ] && fallback="$INFRA_METADATA"
  if [ -s "$source" ]; then cp "$source" "$staged"; else printf '%s\n' "$fallback" > "$staged"; fi
  if [ "$name" = summary.json ]; then
    reducer_args=("$staged")
  else
    reducer_args=(- "$staged")
  fi
  node "$CI_DIR/public-summary.js" "${reducer_args[@]}" 2>/dev/null \
    || printf '%s\n' "$fallback" > "$staged"
  mv "$staged" "$LANE_OUT_DIR/$name"
}

# Writes the job's results (the infra verdict where the VM produced none)
# and publishes them to the report store. Runs once per job, from `run` or,
# when `run` was cut short, from `cleanup`.
results_finalize() {
  [ -n "${LANE_OUT_DIR:-}" ] && [ -z "${LANE_RESULTS_DONE:-}" ] || return 0
  [ -f "$LANE_OUT_DIR/summary.json" ] || stage_result summary.json ""
  [ -f "$LANE_OUT_DIR/metadata.json" ] || stage_result metadata.json ""
  if [ -n "${LANE_PUBLISH_PREFIX:-}" ]; then
    local name
    for name in summary.json metadata.json; do
      ci_retry 120 "publish $name" aws s3 cp "$LANE_OUT_DIR/$name" \
        "s3://$CI_R2_BUCKET/$LANE_PUBLISH_PREFIX/$name" \
        --endpoint-url "$CI_R2_ENDPOINT" --only-show-errors || true
    done
  fi
  ci_export LANE_RESULTS_DONE 1
}

# Releases the VM (and pool) once per job. A pool is released only after its
# VM is gone, so no other job can drive staging users a live VM still holds;
# a pool whose VM could not be deleted frees itself when its lease expires,
# after the VM's own run limit.
vm_release() {
  [ -z "${LANE_RELEASED:-}" ] || return 0
  if [ -n "${CI_FIXED_VM:-}" ]; then
    ci_fixed_vm_release
  else
    ci_vm_delete && ci_lease_release
  fi
  ci_export LANE_RELEASED 1
}

cmd_cleanup() {
  results_finalize
  vm_release
}

# Runs from the EXIT trap, on success, failure or interruption.
finalize() {
  [ -n "${LANE_OUT_DIR:-}" ] || return 0
  group "Release the VM"
  cmd_cleanup
  [ -z "${GITHUB_ACTIONS:-}" ] || echo "::endgroup::"
  return 0
}

cmd_run() {
  local lane="" ref="" harness_ref="" suite="" vm="" tests="" exec_suffix=""
  local free_slots="" profile_flags="" obsidian_version="" obsidian_url=""
  local out="." publish_prefix=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --lane) lane="$2" ;;
      --ref) ref="$2" ;;
      --harness-ref) harness_ref="$2" ;;
      --suite) suite="$2" ;;
      --vm) vm="$2" ;;
      --tests) tests="$2" ;;
      --exec-suffix) exec_suffix="$2" ;;
      --free-slots) free_slots="$2" ;;
      --profile-flags) profile_flags="$2" ;;
      --obsidian-version) obsidian_version="$2" ;;
      --obsidian-url) obsidian_url="$2" ;;
      --out) out="$2" ;;
      --publish-prefix) publish_prefix="$2" ;;
      *) die "lane.sh run: unknown option $1" ;;
    esac
    shift 2
  done
  [ -n "$lane" ] || die "lane.sh run: --lane is required"
  if [ -z "$vm" ]; then
    case "$lane" in bi|tt|mn) ;; *) die "lane.sh run: a pool lane is bi, tt or mn" ;; esac
  fi
  [ -n "$suite" ] || { [ "$lane" = mn ] && suite=multinode || suite=scripted; }
  local remote
  case "$suite" in
    scripted) remote="$CI_DIR/remote-suite.sh" ;;
    multinode) remote="$CI_DIR/remote-multinode.sh" ;;
    unit) remote="$CI_DIR/remote-unit.sh" ;;
    *) die "lane.sh run: --suite must be scripted, multinode or unit" ;;
  esac
  [ -n "$ref" ] || die "lane.sh run: --ref is required"
  [ -n "$harness_ref" ] || die "lane.sh run: --harness-ref is required"
  if [ "$suite" != unit ]; then
    [ -n "$tests" ] || die "lane.sh run: --tests is required"
    [ -n "$exec_suffix" ] || die "lane.sh run: --exec-suffix is required"
  else
    require_env RELAY_GIT_CRYPT_KEY_B64
  fi
  require_env HARNESS_DEPLOY_KEY CI_R2_ENDPOINT AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
  mkdir -p "$out"
  out="$(cd "$out" && pwd)"
  rm -f "$out/summary.json" "$out/metadata.json"
  # Exported so a `cleanup` step can finish a job this run could not.
  ci_export LANE_OUT_DIR "$out"
  ci_export LANE_PUBLISH_PREFIX "$publish_prefix"

  trap 'rc=$?; finalize; exit $rc' EXIT
  trap 'exit 130' INT TERM

  if [ -n "$vm" ]; then
    group "Start $vm"
    ci_export VM_NAME "$vm"
    ci_export CI_FIXED_VM 1
    ci_fixed_vm_ensure || return 1
  else
    group "Lease a pool and create its VM"
    ci_lease_acquire "$lane" || return 1
    ci_vm_create || return 1
  fi

  group "Wait for the VM to boot"
  ci_ssh_setup
  ci_vm_wait_ready || return 1

  group "Provision VM credentials"
  if [ -n "${CI_SA_KEY:-}" ]; then
    ci_vm_put "service-account key" "$CI_SA_KEY" ci-sa-key.json || return 1
  fi
  ci_vm_put "deploy key" "$HARNESS_DEPLOY_KEY" ci-deploy-key || return 1
  ci_retry 300 "config dir creation" ci_ssh "mkdir -p ~/.config/relay-e2e" || return 1
  ci_vm_put "R2 env" "export CI_R2_ENDPOINT='$CI_R2_ENDPOINT'
export CI_R2_ACCESS_KEY_ID='$AWS_ACCESS_KEY_ID'
export CI_R2_SECRET_ACCESS_KEY='$AWS_SECRET_ACCESS_KEY'" .config/relay-e2e/r2-env.sh || return 1
  if [ "$suite" = unit ]; then
    local key="$RUNNER_TEMP/relay-git-crypt-key"
    printf '%s' "$RELAY_GIT_CRYPT_KEY_B64" | base64 -d > "$key" \
      || { echo "::error::RELAY_GIT_CRYPT_KEY_B64 is not valid base64"; return 1; }
    chmod 600 "$key"
    ci_retry 300 "copy git-crypt key" ci_scp "$key" "$VM_NAME:.config/relay-e2e/relay-git-crypt-key"
    local rc=$?
    rm -f "$key"
    [ "$rc" -eq 0 ] || return 1
    ci_retry 300 "restrict git-crypt key" ci_ssh "chmod 600 ~/.config/relay-e2e/relay-git-crypt-key" || return 1
  fi

  group "Run ${tests:-$suite} on $VM_NAME"
  # A fixed VM still holds the previous job's results.
  ci_retry 300 "clear previous results" ci_ssh \
    "rm -f ~/test-summary.json ~/test-metadata.json ~/test-plan-suite-output.txt ~/mn-lane-output.txt" || return 1
  local run_status=0
  ci_vm_run "$remote" \
    --ref "$ref" \
    --harness-ref "$harness_ref" \
    --tests "$tests" \
    --exec-suffix "${exec_suffix//\{pool\}/${CI_POOL:-}}" \
    --shared-slots "${CI_SLOTS:-}" \
    --free-slots "$free_slots" \
    --profile-flags "$profile_flags" \
    --obsidian-version "$obsidian_version" \
    --obsidian-url "$obsidian_url" \
    || run_status=$?
  echo "Run exited with status $run_status"

  group "Fetch results"
  rm -f "$RUNNER_TEMP/raw-summary.json" "$RUNNER_TEMP/raw-metadata.json"
  ci_vm_fetch test-summary.json "$RUNNER_TEMP/raw-summary.json" || true
  ci_vm_fetch test-metadata.json "$RUNNER_TEMP/raw-metadata.json" || true
  stage_result summary.json "$RUNNER_TEMP/raw-summary.json"
  stage_result metadata.json "$RUNNER_TEMP/raw-metadata.json"
  if [ "$run_status" -ne 0 ]; then
    group "Upload crash evidence to the private report store"
    ci_vm_run "$CI_DIR/remote-crash-upload.sh" || true
  fi
  return "$run_status"
}

case "${1:-}" in
  run) shift; cmd_run "$@" ;;
  cleanup) shift; cmd_cleanup ;;
  *) echo "usage: lane.sh run [options] | lane.sh cleanup" >&2; exit 2 ;;
esac
