# Shared helpers for E2E jobs that run on a leased GCE pool VM.
#
# Source this file in each workflow step that needs it; state that must
# survive between steps (VM_NAME, CI_POOL, CI_SLOTS, CI_LEASE_OWNER) is
# exported through $GITHUB_ENV.
#
# Leasing. Each pool is a pair of staging users. A pool is held through a
# lock object in the CI bucket, written with a conditional PUT: If-None-Match
# for a free pool, If-Match on the observed ETag to take over a released or
# expired one. Every lane (burn-in, parallel lane, multi-node) leases through
# the same objects, so two jobs never drive the same staging users.
#
# VM names. Each job's VM gets a name no other job uses. SSH through IAP to a
# VM created under a name that was deleted moments earlier times out during
# the banner exchange for minutes, so pool VMs never reuse names. Each VM also
# deletes itself after CI_VM_MAX_RUN, so a crashed job cannot leak it.
#
# Required env: GCP_PROJECT, VM_ZONE, VM_IMAGE_FAMILY, CI_R2_ENDPOINT,
# CI_R2_BUCKET, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY.

CI_POOL_COUNT="${CI_POOL_COUNT:-8}"
# Longer than any E2E job's timeout-minutes, so a live job never loses its VM.
CI_VM_MAX_RUN="${CI_VM_MAX_RUN:-3h}"
# Longer than CI_VM_MAX_RUN, so an expired lease never belongs to a live VM.
CI_LEASE_TTL_SECONDS="${CI_LEASE_TTL_SECONDS:-14400}"
# How long a job waits for a free pool before giving up.
CI_LEASE_WAIT_SECONDS="${CI_LEASE_WAIT_SECONDS:-2700}"
CI_LEASE_POLL_SECONDS="${CI_LEASE_POLL_SECONDS:-30}"
# How often a running job's output is collected from the VM.
CI_JOB_POLL_SECONDS="${CI_JOB_POLL_SECONDS:-20}"

export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-auto}"
export AWS_EC2_METADATA_DISABLED=true

ci_pool_slots() {
  case "$1" in
    1) echo "11,12" ;; 2) echo "15,16" ;; 3) echo "19,20" ;; 4) echo "23,25" ;;
    5) echo "9,10" ;; 6) echo "13,14" ;; 7) echo "17,18" ;; 8) echo "21,22" ;;
    *) return 1 ;;
  esac
}

# Exports a variable here and, under Actions, to the job's later steps.
ci_export() {
  export "$1=$2"
  if [ -n "${GITHUB_ENV:-}" ]; then
    echo "$1=$2" >> "$GITHUB_ENV"
  fi
}

# ci_retry BUDGET_SECONDS LABEL CMD...
# Runs CMD until it succeeds, backing off 5s, 10s, 20s, then every 30s, and
# gives up once BUDGET_SECONDS have passed.
ci_retry() {
  local budget="$1" label="$2"
  shift 2
  local deadline=$(( $(date +%s) + budget )) delay=5 attempt=1 rc
  while :; do
    "$@" && return 0
    rc=$?
    if [ $(( $(date +%s) + delay )) -ge "$deadline" ]; then
      echo "::error::$label failed after $attempt attempts over ${budget}s (last exit $rc)"
      return "$rc"
    fi
    echo "$label failed (exit $rc, attempt $attempt); retrying in ${delay}s"
    sleep "$delay"
    attempt=$((attempt + 1))
    delay=$((delay * 2))
    [ "$delay" -gt 30 ] && delay=30
  done
}

# --- Pool lease -------------------------------------------------------------

_ci_s3api() {
  aws s3api --endpoint-url "$CI_R2_ENDPOINT" "$@"
}

_ci_lease_key() {
  echo "leases/e2e-pool-p$1.json"
}

# Matrix legs share a run id and attempt, so the random suffix is what keeps
# a later leg on the same pool from reusing an earlier leg's VM name.
_ci_vm_name() {
  echo "relay-e2e-$CI_LANE-p$1-$GITHUB_RUN_ID-$CI_VM_SUFFIX"
}

_ci_lease_write() {
  # _ci_lease_write POOL RELEASED CONDITION...
  local k="$1" released="$2"
  shift 2
  local body
  body="$(mktemp)"
  jq -cn \
    --arg owner "$CI_LEASE_OWNER" \
    --arg vm "$(_ci_vm_name "$k")" \
    --argjson expires "$(( $(date +%s) + CI_LEASE_TTL_SECONDS ))" \
    --argjson released "$released" \
    '{owner: $owner, vm: $vm, expires: $expires, released: $released}' > "$body"
  _ci_s3api put-object --bucket "$CI_R2_BUCKET" --key "$(_ci_lease_key "$k")" \
    --body "$body" --content-type application/json "$@" > /dev/null
  local rc=$?
  rm -f "$body"
  return "$rc"
}

# _ci_lease_read POOL BODY_FILE: writes the lease body and prints its ETag.
_ci_lease_read() {
  _ci_s3api get-object --bucket "$CI_R2_BUCKET" --key "$(_ci_lease_key "$1")" \
    "$2" --query ETag --output text
}

# _ci_lease_try POOL: 0 when this job now holds the pool, 1 otherwise.
# _ci_lease_report ERROR_TEXT: prints a lease-store error unless it is the
# expected precondition failure of a pool that is already held.
_ci_lease_report() {
  case "$1" in
    *PreconditionFailed*|*ConditionalRequestConflict*|*"(412)"*|*"(409)"*) ;;
    *) echo "Lease store error: $(printf '%s' "$1" | tail -n 2)" ;;
  esac
}

_ci_lease_try() {
  local k="$1" current etag released expires err
  if err=$(_ci_lease_write "$k" false --if-none-match '*' 2>&1); then
    return 0
  fi
  _ci_lease_report "$err"
  current="$(mktemp)"
  if ! etag="$(_ci_lease_read "$k" "$current" 2>/dev/null)"; then
    rm -f "$current"
    return 1
  fi
  # A lease that cannot be read counts as held: taking it over could put two
  # jobs on one pool, while leaving it only costs the time until it expires.
  if ! jq -e 'type == "object" and (.expires | type) == "number"' "$current" >/dev/null 2>&1; then
    rm -f "$current"
    return 1
  fi
  released="$(jq -r '.released == true' "$current")"
  expires="$(jq -r '.expires | floor' "$current")"
  rm -f "$current"
  if [ "$released" != "true" ] && [ "$expires" -gt "$(date +%s)" ]; then
    return 1
  fi
  # The If-Match fails if another job took the pool since the read above.
  if ! err=$(_ci_lease_write "$k" false --if-match "$etag" 2>&1); then
    _ci_lease_report "$err"
    return 1
  fi
}

# ci_lease_acquire LANE: leases a pool and exports CI_LANE, CI_POOL,
# CI_SLOTS, CI_LEASE_OWNER and a VM_NAME unique to this job attempt.
ci_lease_acquire() {
  local deadline k
  ci_export CI_LANE "$1"
  ci_export CI_VM_SUFFIX "$(od -An -N3 -tx1 /dev/urandom | tr -d ' \n')"
  ci_export CI_LEASE_OWNER "$CI_LANE/$GITHUB_RUN_ID/$GITHUB_RUN_ATTEMPT/$GITHUB_JOB/${CI_LEASE_TAG:-}"
  deadline=$(( $(date +%s) + CI_LEASE_WAIT_SECONDS ))
  while :; do
    for k in $(seq 1 "$CI_POOL_COUNT" | shuf); do
      if _ci_lease_try "$k"; then
        ci_export CI_POOL "p$k"
        ci_export CI_SLOTS "$(ci_pool_slots "$k")"
        ci_export VM_NAME "$(_ci_vm_name "$k")"
        echo "Leased pool p$k (shared slots $CI_SLOTS) as $CI_LEASE_OWNER"
        return 0
      fi
    done
    if [ "$(date +%s)" -ge "$deadline" ]; then
      echo "::error::No pool became free within ${CI_LEASE_WAIT_SECONDS}s"
      return 1
    fi
    echo "All $CI_POOL_COUNT pools are leased; waiting for one to free up"
    sleep "$CI_LEASE_POLL_SECONDS"
  done
}

# ci_lease_release: frees this job's pool, if it still holds it.
ci_lease_release() {
  [ -n "${CI_POOL:-}" ] || return 0
  local k="${CI_POOL#p}" current etag owner attempt
  for attempt in 1 2 3 4 5; do
    current="$(mktemp)"
    if etag="$(_ci_lease_read "$k" "$current" 2>/dev/null)"; then
      owner="$(jq -r '.owner // ""' "$current" 2>/dev/null)"
      rm -f "$current"
      if [ "$owner" != "$CI_LEASE_OWNER" ]; then
        echo "Pool $CI_POOL is held by $owner; nothing to release"
        return 0
      fi
      if _ci_lease_write "$k" true --if-match "$etag"; then
        echo "Released pool $CI_POOL"
        return 0
      fi
    else
      rm -f "$current"
    fi
    sleep $((attempt * 5))
  done
  echo "::warning::Could not release pool $CI_POOL; its lease expires on its own"
}

# --- VM lifecycle -----------------------------------------------------------

# ci_vm_create: creates VM_NAME. The name is unique to this job attempt, so
# "already exists" means an earlier attempt of this call succeeded.
ci_vm_create() {
  local err attempt
  for attempt in 1 2 3; do
    if err="$(gcloud compute instances create "$VM_NAME" \
      --project="$GCP_PROJECT" \
      --zone="$VM_ZONE" \
      --machine-type=e2-standard-4 \
      --image-family="$VM_IMAGE_FAMILY" \
      --image-project="$GCP_PROJECT" \
      --boot-disk-size=20GB \
      --boot-disk-type=pd-standard \
      --metadata=block-project-ssh-keys=TRUE \
      --max-run-duration="$CI_VM_MAX_RUN" \
      --instance-termination-action=DELETE \
      --labels="relay-e2e-lane=$CI_LANE,relay-e2e-pool=$CI_POOL,gh-run=$GITHUB_RUN_ID" \
      --tags=relay-e2e 2>&1 >/dev/null)"; then
      echo "Created $VM_NAME"
      return 0
    fi
    if echo "$err" | grep -q "already exists"; then
      echo "$VM_NAME already exists from an earlier attempt"
      return 0
    fi
    if echo "$err" | grep -qE "ZONE_RESOURCE_POOL_EXHAUSTED|does not have enough resources"; then
      echo "::error::Zone $VM_ZONE has no capacity. Set the CI_VM_ZONE repository variable to move CI to another zone."
      return 1
    fi
    echo "$err"
    echo "VM create failed (attempt $attempt/3)"
    sleep $((attempt * 15))
  done
  return 1
}

ci_vm_delete() {
  [ -n "${VM_NAME:-}" ] || return 0
  local err attempt
  for attempt in 1 2 3 4 5; do
    if err="$(gcloud compute instances delete "$VM_NAME" \
      --zone="$VM_ZONE" --project="$GCP_PROJECT" --quiet 2>&1)"; then
      echo "Deleted $VM_NAME"
      return 0
    fi
    if echo "$err" | grep -q "was not found"; then
      return 0
    fi
    echo "$err"
    sleep $((attempt * 10))
  done
  echo "::warning::Could not delete $VM_NAME; it deletes itself after $CI_VM_MAX_RUN"
  return 1
}

# --- Fixed VMs -------------------------------------------------------------
#
# A fixed VM persists between jobs: each job starts it, and stops it when
# done. Keys copied onto it are removed at the end of every job, because its
# disk outlives the job.

# ci_fixed_vm_ensure: brings VM_NAME to RUNNING, creating it with the
# harness's infra/gcp-linux-vm.sh when it does not exist.
ci_fixed_vm_ensure() {
  local status="" i
  for i in $(seq 1 60); do
    status=$(gcloud compute instances describe "$VM_NAME" \
      --zone="$VM_ZONE" --project="$GCP_PROJECT" \
      --format='get(status)' 2>/dev/null || echo NOT_FOUND)
    case "$status" in
      PROVISIONING|STAGING|STOPPING|SUSPENDING|REPAIRING)
        echo "$VM_NAME is $status; waiting for a stable state ($i/60)"
        sleep 10 ;;
      *) break ;;
    esac
  done
  case "$status" in
    RUNNING) echo "$VM_NAME is running" ;;
    TERMINATED|STOPPED)
      echo "Starting $VM_NAME"
      ci_retry 300 "start $VM_NAME" gcloud compute instances start "$VM_NAME" \
        --zone="$VM_ZONE" --project="$GCP_PROJECT" --quiet ;;
    SUSPENDED)
      echo "Resuming $VM_NAME"
      ci_retry 300 "resume $VM_NAME" gcloud compute instances resume "$VM_NAME" \
        --zone="$VM_ZONE" --project="$GCP_PROJECT" --quiet ;;
    NOT_FOUND) _ci_fixed_vm_create ;;
    *) echo "::error::$VM_NAME is $status"; return 1 ;;
  esac
}

_ci_fixed_vm_create() {
  echo "$VM_NAME does not exist; creating it with the harness infra script"
  local harness="$RUNNER_TEMP/harness-infra" key="$RUNNER_TEMP/harness-infra-key"
  printf '%s\n' "$HARNESS_DEPLOY_KEY" > "$key"
  chmod 600 "$key"
  rm -rf "$harness"
  GIT_SSH_COMMAND="ssh -i $key -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new" \
    ci_retry 300 "harness clone" git clone --quiet --depth 1 \
    git@github.com:No-Instructions/relay-harness.git "$harness"
  local rc=$?
  rm -f "$key"
  [ "$rc" -eq 0 ] || return 1
  (cd "$harness" && GCP_PROJECT="$GCP_PROJECT" GCP_ZONE="$VM_ZONE" GCP_VM_NAME="$VM_NAME" \
    GCP_VM_DISK_SIZE=20GB GCP_VM_DISK_TYPE=pd-standard ./infra/gcp-linux-vm.sh create)
}

# ci_fixed_vm_release: removes this job's credentials from VM_NAME and asks
# it to stop.
ci_fixed_vm_release() {
  [ -n "${VM_NAME:-}" ] || return 0
  ci_retry 120 "credential removal" ci_ssh \
    'rm -f ~/ci-sa-key.json ~/ci-deploy-key ~/.ssh/ci-deploy-key ~/.config/relay-e2e/r2-env.sh ~/.config/relay-e2e/relay-git-crypt-key' \
    || echo "::warning::Could not remove credentials from $VM_NAME"
  local status
  status=$(gcloud compute instances describe "$VM_NAME" \
    --zone="$VM_ZONE" --project="$GCP_PROJECT" --format='get(status)' 2>/dev/null || echo NOT_FOUND)
  if [ "$status" = RUNNING ]; then
    gcloud compute instances stop "$VM_NAME" --zone="$VM_ZONE" --project="$GCP_PROJECT" \
      --quiet --async >/dev/null 2>&1 || true
    echo "Requested a stop of $VM_NAME"
  fi
}

# --- SSH --------------------------------------------------------------------

# IAP tunnel setup counts against ConnectTimeout, so it must allow for a slow
# tunnel as well as sshd's banner.
CI_SSH_OPTIONS=(-oConnectTimeout=45 -oServerAliveInterval=15 -oServerAliveCountMax=8)

ci_ssh_setup() {
  mkdir -p ~/.ssh
  [ -f ~/.ssh/google_compute_engine ] \
    || ssh-keygen -t rsa -b 3072 -f ~/.ssh/google_compute_engine -N "" -q
}

ci_ssh() {
  local flags=() option
  for option in "${CI_SSH_OPTIONS[@]}"; do flags+=(--ssh-flag="$option"); done
  gcloud compute ssh "$VM_NAME" --quiet \
    --zone="$VM_ZONE" --project="$GCP_PROJECT" \
    --tunnel-through-iap "${flags[@]}" \
    --command="$1"
}

# ci_scp SRC DEST: one side is "$VM_NAME:path", with path relative to the
# VM user's home directory.
ci_scp() {
  local flags=() option
  for option in "${CI_SSH_OPTIONS[@]}"; do flags+=(--scp-flag="$option"); done
  gcloud compute scp --quiet \
    --zone="$VM_ZONE" --project="$GCP_PROJECT" \
    --tunnel-through-iap "${flags[@]}" "$1" "$2"
}

# ci_vm_wait_ready: waits until the VM has finished booting, not just until
# sshd first answers. Services still starting after the first answer keep the
# VM unreachable for stretches of the next minutes.
# A boot that is still settling after two minutes is reported, with its
# pending systemd jobs, and the job goes ahead.
ci_vm_wait_ready() {
  ci_retry 600 "VM boot" ci_ssh \
    'state=$(timeout 120 systemctl is-system-running --wait 2>/dev/null); echo "boot state: ${state:-unknown}"; case "$state" in running|degraded) ;; *) echo "::warning::VM boot still settling after 120s"; systemctl list-jobs --no-pager | head -20 ;; esac'
}

# ci_vm_put LABEL CONTENT DEST: writes CONTENT to DEST (relative to the VM
# user's home) with mode 600.
ci_vm_put() {
  local label="$1" content="$2" dest="$3" tmp
  tmp="$(mktemp)"
  chmod 600 "$tmp"
  printf '%s\n' "$content" > "$tmp"
  local rc=0
  ci_retry 300 "copy $label" ci_scp "$tmp" "$VM_NAME:$dest" || rc=$?
  rm -f "$tmp"
  [ "$rc" -eq 0 ] || return "$rc"
  ci_retry 300 "restrict $label" ci_ssh "chmod 600 ~/$dest"
}

# ci_vm_fetch REMOTE LOCAL: copies REMOTE (relative to the VM user's home).
# Retries dropped connections; a missing file returns 1 at once.
ci_vm_fetch() {
  local remote="$1" local_path="$2" deadline rc delay=5
  deadline=$(( $(date +%s) + 300 ))
  while :; do
    ci_ssh "cat ~/$remote" > "$local_path.tmp"
    rc=$?
    if [ "$rc" -eq 0 ]; then
      mv "$local_path.tmp" "$local_path"
      return 0
    fi
    rm -f "$local_path.tmp"
    if [ "$rc" -ne 255 ] || [ "$(date +%s)" -ge "$deadline" ]; then
      echo "Could not fetch $remote (exit $rc)"
      return 1
    fi
    sleep "$delay"
    delay=$((delay * 2))
    [ "$delay" -gt 30 ] && delay=30
  done
}

# ci_net_retry CMD...: retries a network command 5 times, 10s apart and
# growing. ci_vm_run ships it to the VM with each job script.
ci_net_retry() {
  local attempt=1
  until "$@"; do
    if [ "$attempt" -ge 5 ]; then
      echo "giving up after $attempt attempts: $*" >&2
      return 1
    fi
    echo "retrying in $((attempt * 10))s (attempt $attempt): $*" >&2
    sleep $((attempt * 10))
    attempt=$((attempt + 1))
  done
}

# ci_public_filter: passes through only the harness output lines that may be
# published: plan verdicts ("[tpNNN] FAIL (exit 1, 123s)"), orchestrator
# progress ("[mn] ...") and the private report's URL. Test content never reaches the public log, whatever
# a harness prints. ci_vm_run ships it to the VM with each job script.
ci_public_filter() {
  sed -u 's/\r$//' | grep --line-buffered -E '^\[tp[0-9]{3}\] (PASS|FAIL|SKIP|ERROR)( \((exit [0-9]+, [0-9]+s|[a-z0-9-]+)\))?$|^\[mn\] |^report: https://ci\.system3\.dev/[A-Za-z0-9._/-]+$' || true
}

# ci_vm_run SCRIPT ARGS...: runs SCRIPT on the VM with ARGS as its positional
# parameters, detached from any SSH session, streams its stdout here, and
# returns its exit status. Dropped SSH connections only delay the stream.
#
# The repository is public, so its Actions logs are public: only the script's
# stdout reaches them. Its stderr stays on the VM in ~/ci-job/err.log (moved
# to ~/ci-job.prev/err.log when the next job starts).
#
# The script can call ci_net_retry and ci_public_filter.
ci_vm_run() {
  local script="$1"
  shift
  local job="$RUNNER_TEMP/ci-job.sh"
  {
    echo '#!/usr/bin/env bash'
    printf 'set --'
    printf ' %q' "$@"
    echo
    declare -f ci_net_retry ci_public_filter
    cat "$script"
  } > "$job"

  # The previous job's directory is kept as ~/ci-job.prev so a later job (a
  # failure-path upload) can read its err.log.
  # A job still running from an interrupted run (a fixed VM whose stop did
  # not happen) is ended first, so two jobs never share the VM.
  ci_retry 300 "job directory setup" ci_ssh \
    'if [ -f ~/ci-job/pid ] && [ ! -f ~/ci-job/exit ]; then kill -TERM -- "-$(cat ~/ci-job/pid)" 2>/dev/null; sleep 5; fi; rm -rf ~/ci-job.prev; if [ -d ~/ci-job ]; then mv ~/ci-job ~/ci-job.prev; fi; mkdir -p ~/ci-job' \
    || return 1
  ci_retry 300 "job upload" ci_scp "$job" "$VM_NAME:ci-job/run.sh" || return 1
  # mkdir is the launch guard: a retried launch whose first attempt started
  # the job but lost its connection must not start a second copy.
  ci_retry 300 "job launch" ci_ssh \
    'cd ~/ci-job && if mkdir started 2>/dev/null; then setsid nohup bash -c "echo \$\$ > pid; bash run.sh > out.log 2> err.log; echo \$? > exit.tmp && mv exit.tmp exit" < /dev/null > /dev/null 2>&1 & fi; test -d started' \
    || return 1

  local offset=0 failed_since=0 now chunk="$RUNNER_TEMP/ci-job.chunk" status code printable
  while :; do
    sleep "$CI_JOB_POLL_SECONDS"
    # The exit code is read before the log size, so a finished job's log is
    # complete by the time its exit code is seen.
    if ci_ssh "e=\$(cat ~/ci-job/exit 2>/dev/null); s=\$(stat -c %s ~/ci-job/out.log 2>/dev/null || echo 0); printf 'size=%s exit=%s\n' \"\$s\" \"\$e\"; tail -c +$((offset + 1)) ~/ci-job/out.log 2>/dev/null | head -c \$((s - $offset))" \
      > "$chunk" 2> "$chunk.err"; then
      failed_since=0
      status="$(head -n 1 "$chunk")"
      code="${status##*exit=}"
      tail -n +2 "$chunk" > "$chunk.body"
      printable="$(wc -c < "$chunk.body")"
      # Hold back an unterminated last line until it completes, so other
      # messages never land in the middle of it.
      if [ -z "$code" ] && [ "$printable" -gt 0 ] && [ -n "$(tail -c 1 "$chunk.body")" ]; then
        printable=$((printable - $(tail -n 1 "$chunk.body" | wc -c)))
      fi
      head -c "$printable" "$chunk.body"
      offset=$((offset + printable))
      if [ -n "$code" ]; then
        return "$code"
      fi
    else
      now="$(date +%s)"
      [ "$failed_since" -eq 0 ] && failed_since="$now"
      echo "(VM unreachable; retrying)"
      tail -n 3 "$chunk.err" >&2
      if [ $((now - failed_since)) -ge 900 ]; then
        echo "::error::VM unreachable for 15 minutes while running the job"
        return 255
      fi
    fi
  done
}
