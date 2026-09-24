#!/usr/bin/env bash
# Bakes the Windows E2E image: boots a Windows Server 2022 VM, installs the
# E2E software stack (Node, Git, ffmpeg, Obsidian) with the harness's
# infra/windows-setup.ps1, generalizes it with GCESysprep, and captures a GCE
# image in the relay-e2e-windows family, which lane-windows.sh boots.
#
#   bake-windows-image.sh run [--harness-ref REF] [--image-name NAME] [--keep-vm]
#   bake-windows-image.sh cleanup
#
# Environment: HARNESS_DEPLOY_KEY; GCP_PROJECT and VM_ZONE have defaults.
# gcloud must already be authenticated.
set -uo pipefail

CI_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export GCP_PROJECT="${GCP_PROJECT:-tactile-timer-426817-t6}"
export VM_ZONE="${VM_ZONE:-us-west2-a}"
export GITHUB_RUN_ID="${GITHUB_RUN_ID:-local$(date +%s)}"
RUNNER_TEMP="${RUNNER_TEMP:-$(mktemp -d)}"
IMAGE_FAMILY=relay-e2e-windows
KEY="$HOME/.ssh/relay-win-bake"

# shellcheck source=gce-lane.sh
source "$CI_DIR/gce-lane.sh"

wssh() {
  gcloud compute ssh "relay@$VM_NAME" --quiet --zone="$VM_ZONE" --project="$GCP_PROJECT" \
    --tunnel-through-iap --ssh-key-file="$KEY" \
    --ssh-flag="-oStrictHostKeyChecking=no" --ssh-flag="-oUserKnownHostsFile=/dev/null" \
    --ssh-flag="-oConnectTimeout=30" "$@"
}

cmd_cleanup() {
  if [ -n "${KEEP_VM:-}" ]; then
    echo "Keeping $VM_NAME for inspection"
    return 0
  fi
  ci_vm_delete
}

cmd_run() {
  local harness_ref="origin/main" image_name="" keep_vm=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --harness-ref) harness_ref="${2:-origin/main}"; shift 2 ;;
      --image-name) image_name="$2"; shift 2 ;;
      --keep-vm) keep_vm=1; shift ;;
      *) echo "::error::bake-windows-image.sh run: unknown option $1"; return 2 ;;
    esac
  done
  [ -n "${HARNESS_DEPLOY_KEY:-}" ] || { echo "::error::HARNESS_DEPLOY_KEY must be set"; return 2; }
  [ -n "$image_name" ] || image_name="relay-e2e-windows-$(date +%Y%m%d)"
  [ -z "$keep_vm" ] || ci_export KEEP_VM 1

  echo "== Fetch the harness setup script"
  local harness="$RUNNER_TEMP/bake-harness" deploy_key="$RUNNER_TEMP/bake-deploy-key"
  printf '%s\n' "$HARNESS_DEPLOY_KEY" > "$deploy_key"
  chmod 600 "$deploy_key"
  rm -rf "$harness"
  GIT_SSH_COMMAND="ssh -i $deploy_key -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new" \
    ci_retry 300 "harness clone" git clone --quiet --depth 50 \
    git@github.com:No-Instructions/relay-harness.git "$harness"
  local rc=$?
  rm -f "$deploy_key"
  [ "$rc" -eq 0 ] || return 1
  git -C "$harness" checkout --quiet --detach "origin/${harness_ref#origin/}" 2>/dev/null \
    || git -C "$harness" checkout --quiet --detach "$harness_ref" || return 1
  echo "Harness commit: $(git -C "$harness" rev-parse HEAD)"
  [ -f "$harness/infra/windows-setup.ps1" ] || { echo "::error::infra/windows-setup.ps1 is missing"; return 1; }

  echo "== Create the build VM"
  mkdir -p ~/.ssh
  rm -f "$KEY" "$KEY.pub"
  ssh-keygen -t rsa -b 3072 -f "$KEY" -N "" -q
  ci_export VM_NAME "relay-e2e-winbake-$GITHUB_RUN_ID"
  trap 'rc=$?; cmd_cleanup; exit $rc' EXIT
  local err
  # The relay-e2e tag admits the VM through the IAP-to-tcp:22 firewall rule.
  # Stdout is discarded: the create table prints instance addresses, which do
  # not belong in the public log.
  if ! err=$(gcloud compute instances create "$VM_NAME" \
    --project="$GCP_PROJECT" --zone="$VM_ZONE" \
    --machine-type=e2-standard-4 \
    --image-family=windows-2022 --image-project=windows-cloud \
    --boot-disk-size=100GB --boot-disk-type=pd-ssd --tags=relay-e2e \
    --max-run-duration="$CI_VM_MAX_RUN" --instance-termination-action=DELETE \
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
  # First boot, specialization and the OpenSSH install take well past ten
  # minutes on Windows Server 2022.
  if ! ci_retry 1500 "Windows SSH" wssh --command="Write-Output ready"; then
    echo "----- serial console (RELAY-STARTUP markers) -----"
    gcloud compute instances get-serial-port-output "$VM_NAME" --port 1 \
      --zone="$VM_ZONE" --project="$GCP_PROJECT" 2>&1 | tail -250 || true
    return 1
  fi

  echo "== Install the software stack"
  # scp mishandles Windows C:\ destinations, so the setup script travels as
  # base64 inside a PowerShell command.
  local b64
  b64=$(base64 -w0 "$harness/infra/windows-setup.ps1")
  ci_retry 300 "write setup script" wssh \
    --command="New-Item -ItemType Directory -Path 'C:\\relay-e2e-testing' -Force | Out-Null; [IO.File]::WriteAllText('C:\\relay-e2e-testing\\windows-setup.ps1',[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('$b64')))" \
    || return 1
  # No -User: software only (Chocolatey, Node, Git, ffmpeg, Obsidian), so the
  # image carries no slot, vault or auth state.
  wssh --command="powershell -ExecutionPolicy Bypass -File C:\\relay-e2e-testing\\windows-setup.ps1" || return 1

  echo "== Generalize with GCESysprep and capture $image_name"
  # A VM booted from a non-generalized image skips first-boot specialization,
  # so its startup script never runs and it is unreachable over SSH.
  local sysprep='C:\Program Files\Google\Compute Engine\sysprep\gcesysprep.bat'
  wssh --command="if (-not (Test-Path '$sysprep')) { throw 'gcesysprep.bat not found' }; 'gcesysprep present'" || return 1
  # GCESysprep powers the VM off, which ends this session.
  timeout 240 gcloud compute ssh "relay@$VM_NAME" --quiet --zone="$VM_ZONE" --project="$GCP_PROJECT" \
    --tunnel-through-iap --ssh-key-file="$KEY" \
    --ssh-flag="-oStrictHostKeyChecking=no" --ssh-flag="-oUserKnownHostsFile=/dev/null" \
    --command="& '$sysprep'" || echo "Sysprep session ended (expected on shutdown)"
  local status="" i
  for i in $(seq 1 40); do
    status=$(gcloud compute instances describe "$VM_NAME" --zone="$VM_ZONE" \
      --project="$GCP_PROJECT" --format='value(status)' 2>/dev/null || echo "")
    echo "  status: ${status:-<none>} ($i/40)"
    [ "$status" = TERMINATED ] && break
    sleep 15
  done
  if [ "$status" != TERMINATED ]; then
    echo "The VM did not stop after sysprep; stopping it"
    gcloud compute instances stop "$VM_NAME" --zone="$VM_ZONE" --project="$GCP_PROJECT" --quiet || return 1
  fi
  gcloud compute images create "$image_name" --project="$GCP_PROJECT" \
    --source-disk="$VM_NAME" --source-disk-zone="$VM_ZONE" --family="$IMAGE_FAMILY" || return 1

  status=$(gcloud compute images describe "$image_name" --project="$GCP_PROJECT" --format='value(status)')
  echo "Image $image_name ($IMAGE_FAMILY): $status"
  [ "$status" = READY ]
}

case "${1:-}" in
  run) shift; cmd_run "$@" ;;
  cleanup) shift; cmd_cleanup ;;
  *) echo "usage: bake-windows-image.sh run [options] | bake-windows-image.sh cleanup" >&2; exit 2 ;;
esac
