#!/usr/bin/env bash
# Runs multi-node plans on a Windows slot VM, from a workflow or a workstation.
#
#   lane-windows.sh run --ref SHA --harness-ref REF --tests LIST
#                       --exec-suffix SUFFIX [--out DIR]
#   lane-windows.sh cleanup
#
# The VM boots from the relay-e2e-windows image; windows-startup.ps1 enables
# sshd for a `relay` administrator that trusts a key generated per run. The
# harness node script (scripts/mn-lane-node.ps1) runs the plans and writes
# test-summary.json and test-metadata.json, which land in DIR. The slot pair
# is fixed by that script (charlie/donna).
#
# Environment: HARNESS_DEPLOY_KEY, CI_R2_ENDPOINT, AWS_ACCESS_KEY_ID,
# AWS_SECRET_ACCESS_KEY; GCP_PROJECT and VM_ZONE have defaults.
set -uo pipefail

CI_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export GCP_PROJECT="${GCP_PROJECT:-tactile-timer-426817-t6}"
export VM_ZONE="${VM_ZONE:-us-west2-a}"
export GITHUB_RUN_ID="${GITHUB_RUN_ID:-local$(date +%s)}"
if [ -z "${RUNNER_TEMP:-}" ]; then
  RUNNER_TEMP="$(mktemp -d)"
  export RUNNER_TEMP
fi
KEY="$HOME/.ssh/relay-mnw-key"

# shellcheck source=gce-lane.sh
source "$CI_DIR/gce-lane.sh"

wssh() {
  gcloud compute ssh "relay@$VM_NAME" --quiet --zone="$VM_ZONE" --project="$GCP_PROJECT" \
    --tunnel-through-iap --ssh-key-file="$KEY" \
    --ssh-flag="-oStrictHostKeyChecking=no" --ssh-flag="-oUserKnownHostsFile=/dev/null" \
    --ssh-flag="-oBatchMode=yes" --ssh-flag="-oPasswordAuthentication=no" \
    --ssh-flag="-oConnectTimeout=45" --ssh-flag="-oServerAliveInterval=15" "$@"
}

# Windows OpenSSH has no scp-friendly shell here, so files travel as base64
# inside a PowerShell command.
wput() {
  local b64
  b64=$(printf '%s\n' "$1" | base64 -w0)
  ci_retry 300 "copy $2" wssh \
    --command="powershell -NoProfile -Command \"[IO.File]::WriteAllText('$2',[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('$b64')))\""
}

wfetch() {
  gcloud compute scp --quiet "relay@$VM_NAME:$1" "$2" \
    --zone="$VM_ZONE" --project="$GCP_PROJECT" --tunnel-through-iap \
    --ssh-key-file="$KEY" 2>/dev/null
}

cmd_cleanup() {
  ci_vm_delete
}

OUT_DIR=""
# Writes the results the VM produced (the infra verdict where it produced
# none), reduced to what may be published: OUT_DIR is uploaded as a public
# artifact, so raw results never land in it. Then deletes the VM.
finalize() {
  [ -n "$OUT_DIR" ] || return 0
  local raw="$RUNNER_TEMP/win-raw"
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

cmd_run() {
  local ref="" harness_ref="" tests="" exec_suffix="" out="."
  while [ $# -gt 0 ]; do
    case "$1" in
      --ref) ref="$2" ;;
      --harness-ref) harness_ref="$2" ;;
      --tests) tests="$2" ;;
      --exec-suffix) exec_suffix="$2" ;;
      --out) out="$2" ;;
      *) echo "::error::lane-windows.sh run: unknown option $1"; return 2 ;;
    esac
    shift 2
  done
  local name
  for name in ref harness_ref tests exec_suffix; do
    [ -n "${!name}" ] || { echo "::error::lane-windows.sh run: --${name//_/-} is required"; return 2; }
  done
  for name in HARNESS_DEPLOY_KEY CI_R2_ENDPOINT AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY; do
    [ -n "${!name:-}" ] || { echo "::error::lane-windows.sh: $name must be set"; return 2; }
  done
  mkdir -p "$out"
  OUT_DIR="$(cd "$out" && pwd)"
  rm -f "$OUT_DIR/summary.json" "$OUT_DIR/metadata.json"
  rm -rf "$RUNNER_TEMP/win-raw"
  trap 'rc=$?; finalize; exit $rc' EXIT
  trap 'exit 130' INT TERM

  echo "== Create the Windows slot VM"
  mkdir -p ~/.ssh
  rm -f "$KEY" "$KEY.pub"
  ssh-keygen -t rsa -b 3072 -f "$KEY" -N "" -q
  ci_export VM_NAME "relay-e2e-mnw-$GITHUB_RUN_ID-$(od -An -N3 -tx1 /dev/urandom | tr -d ' \n')"
  local err
  # Discard stdout: the create table prints instance addresses, which do not
  # belong in the public log.
  if ! err=$(gcloud compute instances create "$VM_NAME" \
    --project="$GCP_PROJECT" --zone="$VM_ZONE" \
    --machine-type=e2-standard-8 \
    --image-family=relay-e2e-windows --image-project="$GCP_PROJECT" \
    --boot-disk-size=100GB --boot-disk-type=pd-ssd --tags=relay-e2e \
    --max-run-duration="$CI_VM_MAX_RUN" --instance-termination-action=DELETE \
    --labels="relay-e2e-lane=mnw,gh-run=$GITHUB_RUN_ID" \
    --metadata=block-project-ssh-keys=TRUE,relay-ssh-pubkey="$(cat "$KEY.pub")" \
    --metadata-from-file=windows-startup-script-ps1="$CI_DIR/windows-startup.ps1" \
    2>&1 >/dev/null); then
    if echo "$err" | grep -qE "ZONE_RESOURCE_POOL_EXHAUSTED|does not have enough resources"; then
      echo "::error::Zone $VM_ZONE has no capacity. Set the CI_VM_ZONE repository variable to move CI to another zone."
    fi
    echo "$err"
    return 1
  fi
  echo "Created $VM_NAME"

  echo "== Wait for Windows SSH"
  # Windows installs and starts sshd from its startup script, which takes
  # several minutes on a fresh VM.
  ci_retry 900 "Windows SSH" wssh --command="Write-Output ready" || return 1

  echo "== Provision credentials and the harness"
  wput "$HARNESS_DEPLOY_KEY" 'C:\ci-deploy-key' || return 1
  wput "\$env:CI_R2_ENDPOINT = '$CI_R2_ENDPOINT'
\$env:CI_R2_ACCESS_KEY_ID = '$AWS_ACCESS_KEY_ID'
\$env:CI_R2_SECRET_ACCESS_KEY = '$AWS_SECRET_ACCESS_KEY'" 'C:\r2-env.ps1' || return 1
  wput "\$ErrorActionPreference = 'Continue'
# Git for Windows hands GIT_SSH_COMMAND to its MSYS shell, which eats
# backslashes, so the key path must use forward slashes.
\$env:GIT_SSH_COMMAND = 'ssh -i C:/ci-deploy-key -o IdentitiesOnly=yes -o StrictHostKeyChecking=no'
if (-not (Test-Path C:\\relay-harness)) {
  \$cloneOut = git clone git@github.com:No-Instructions/relay-harness.git C:\\relay-harness 2>&1
  if (\$LASTEXITCODE -ne 0) { Write-Output \$cloneOut; throw 'harness clone failed' }
}
Set-Location C:\\relay-harness
git checkout -- . 2>&1 | Out-Null; git clean -fdq 2>&1 | Out-Null
git fetch origin 2>&1 | Out-Null
git checkout --detach ('origin/' + '$harness_ref'.Replace('origin/','')) 2>&1 | Out-Null
if (\$LASTEXITCODE -ne 0) { git checkout --detach '$harness_ref' 2>&1 | Out-Null }
if (\$LASTEXITCODE -ne 0) { throw 'harness checkout failed' }
git log -1 --format='harness: %h'" 'C:\win-clone.ps1' || return 1
  ci_retry 300 "harness checkout" wssh --command="powershell -NoProfile -File C:\\win-clone.ps1" || return 1

  echo "== Run $tests on $VM_NAME"
  wput "powershell -NoProfile -File C:\\relay-harness\\scripts\\mn-lane-node.ps1 -ProductRef '$ref' -Plans '$tests' -LaneSlug '$exec_suffix'
exit \$LASTEXITCODE" 'C:\win-run.ps1' || return 1
  local run_status=0
  # The node script's output is harness text: only verdict and progress
  # lines reach the public log; the rest stays in a runner-local file.
  wssh --command="powershell -NoProfile -File C:\\win-run.ps1" 2>&1 \
    | tee "${RUNNER_TEMP:-/tmp}/mn-windows-output.txt" | ci_public_filter
  run_status=${PIPESTATUS[0]}
  echo "Run exited with status $run_status"

  echo "== Fetch results"
  mkdir -p "$RUNNER_TEMP/win-raw"
  ci_retry 120 "fetch summary" wfetch test-summary.json "$RUNNER_TEMP/win-raw/summary.json" || true
  ci_retry 120 "fetch metadata" wfetch test-metadata.json "$RUNNER_TEMP/win-raw/metadata.json" || true
  return "$run_status"
}

case "${1:-}" in
  run) shift; cmd_run "$@" ;;
  cleanup) shift; cmd_cleanup ;;
  *) echo "usage: lane-windows.sh run [options] | lane-windows.sh cleanup" >&2; exit 2 ;;
esac
