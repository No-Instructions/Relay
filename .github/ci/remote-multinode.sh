# Runs multi-node plans on an E2E VM through the harness node script. lane.sh
# uploads this file with ci_vm_run, which supplies the positional parameters,
# ci_net_retry and ci_public_filter.
#
# Options: --ref REF --harness-ref REF --tests LIST --exec-suffix SUFFIX
#          --shared-slots LIST
set -eo pipefail

REF="" HARNESS_REF="" PLANS="" EXEC_SUFFIX="" SLOTS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --ref) REF="$2" ;;
    --harness-ref) HARNESS_REF="$2" ;;
    --tests) PLANS="$2" ;;
    --exec-suffix) EXEC_SUFFIX="$2" ;;
    --shared-slots) SLOTS="$2" ;;
    --free-slots|--profile-flags|--obsidian-version|--obsidian-url) ;;
    *) echo "::error::remote-multinode.sh: unknown option $1"; exit 2 ;;
  esac
  shift 2
done

mkdir -p ~/.ssh
cp ~/ci-deploy-key ~/.ssh/ci-deploy-key 2>/dev/null || true
chmod 600 ~/.ssh/ci-deploy-key 2>/dev/null || true
ssh-keyscan github.com >> ~/.ssh/known_hosts 2>/dev/null || true
export GIT_SSH_COMMAND="ssh -i $HOME/.ssh/ci-deploy-key -o IdentitiesOnly=yes"

if [ ! -d ~/relay-harness ]; then
  ci_net_retry git clone git@github.com:No-Instructions/relay-harness.git ~/relay-harness
fi
cd ~/relay-harness
git checkout -- . && git clean -fdq
ci_net_retry git fetch origin
git checkout --detach "origin/${HARNESS_REF#origin/}" 2>/dev/null \
  || git checkout --detach "$HARNESS_REF"

# The node script's own output is harness text: it goes to a private file,
# and only verdict and progress lines reach the public log.
MN_LOG="$HOME/mn-lane-output.txt"
set +e
bash scripts/mn-lane-node.sh "${REF#origin/}" "$PLANS" "$EXEC_SUFFIX" "$SLOTS" 2>&1 \
  | tee "$MN_LOG" | ci_public_filter
status=${PIPESTATUS[0]}
exit "$status"
