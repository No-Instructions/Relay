# Runs scripted test plans on an E2E VM. lane.sh uploads this file with
# ci_vm_run, which supplies the positional parameters and ci_net_retry.
#
# Options:
#   --ref SHA               product commit to test (required)
#   --harness-ref REF       relay-harness commit or ref (required)
#   --tests LIST            comma-separated plan ids (required)
#   --exec-suffix SUFFIX    report exec-id suffix (required)
#   --shared-slots LIST     staging slots of the leased pool
#   --free-slots LIST       staging slots of the push lane
#   --profile-flags FLAGS   feature-flag overrides for the plugin
#   --obsidian-version V    Obsidian AppImage release (default 1.13.4)
#   --obsidian-url URL      Obsidian AppImage URL; overrides --obsidian-version
#
# Output: ~/test-summary.json and ~/test-metadata.json. The exit status is
# the suite's. Only stdout reaches the public Actions log: the suite writes to
# its log file, which goes to the private report.
set -eo pipefail

REF="" HARNESS_REF="" SELECTED_TESTS="" EXEC_SUFFIX=""
SHARED_SLOTS="" FREE_SLOTS="" PROFILE_FLAGS=""
OBSIDIAN_VERSION="1.13.4" OBSIDIAN_URL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --ref) REF="$2" ;;
    --harness-ref) HARNESS_REF="$2" ;;
    --tests) SELECTED_TESTS="$2" ;;
    --exec-suffix) EXEC_SUFFIX="$2" ;;
    --shared-slots) SHARED_SLOTS="$2" ;;
    --free-slots) FREE_SLOTS="$2" ;;
    --profile-flags) PROFILE_FLAGS="$2" ;;
    --obsidian-version) OBSIDIAN_VERSION="${2:-1.13.4}" ;;
    --obsidian-url) OBSIDIAN_URL="$2" ;;
    *) echo "::error::remote-suite.sh: unknown option $1"; exit 2 ;;
  esac
  shift 2
done
for required in REF HARNESS_REF SELECTED_TESTS EXEC_SUFFIX; do
  if [ -z "${!required}" ]; then
    echo "::error::remote-suite.sh: $required is required"
    exit 2
  fi
done

[ -f ~/.config/relay-e2e/r2-env.sh ] && source ~/.config/relay-e2e/r2-env.sh

# Cached AppImages are keyed by version, or by URL hash for an override, so
# a different installer is never mistaken for a cached one.
if [ -n "$OBSIDIAN_URL" ]; then
  URL_HASH=$(printf '%s' "$OBSIDIAN_URL" | sha256sum | cut -c1-12)
  export OBSIDIAN_PATH="$HOME/obsidian/Obsidian-override-${URL_HASH}.AppImage"
  OBSIDIAN_SOURCE="$OBSIDIAN_URL"
  OBSIDIAN_LABEL="override ($URL_HASH)"
else
  export OBSIDIAN_PATH="$HOME/obsidian/Obsidian-${OBSIDIAN_VERSION}.AppImage"
  OBSIDIAN_SOURCE="https://github.com/obsidianmd/obsidian-releases/releases/download/v${OBSIDIAN_VERSION}/Obsidian-${OBSIDIAN_VERSION}.AppImage"
  OBSIDIAN_LABEL="$OBSIDIAN_VERSION"
fi
if [ ! -f "$OBSIDIAN_PATH" ]; then
  echo "Installing Obsidian $OBSIDIAN_LABEL..."
  mkdir -p ~/obsidian
  # Publish via temp-then-rename: a failed wget leaves a zero-byte file at
  # -O's destination that the cache check would trust forever.
  ci_net_retry wget -q -O "${OBSIDIAN_PATH}.tmp" "$OBSIDIAN_SOURCE"
  chmod +x "${OBSIDIAN_PATH}.tmp"
  mv "${OBSIDIAN_PATH}.tmp" "$OBSIDIAN_PATH"
  echo "Installed Obsidian $OBSIDIAN_LABEL"
fi

rm -rf /tmp/test-reports
rm -f ~/test-summary.json ~/test-metadata.json

if [ -f ~/ci-sa-key.json ]; then
  gcloud auth activate-service-account --key-file="$HOME/ci-sa-key.json"
fi

mkdir -p ~/.ssh
cp ~/ci-deploy-key ~/.ssh/ci-deploy-key
chmod 600 ~/.ssh/ci-deploy-key
cat > ~/.ssh/known_hosts << 'EOF'
github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl
github.com ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEmKSENjQEezOmxkZMy7opKgwFB9nkt5YRrYMjNuG5N87uRgg6CLrbo5wAdT/y6v0mKV0U2w0WZ2YB/++Tpockg=
github.com ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQCj7ndNxQowgcQnjshcLrqPEiiphnt+VTTvDP6mHBL9j1aNUkY4Ue1gvwnGLVlOhGeYrnZaMgRK6+PKCUXaDbC7qtbW8gIkhL7aGCsOr/C56SJMy/BCZfxd1nWzAOxSDPgVsmerOBYfNqltV9/hWCqBywINIR+5dIg6JTJ72pcEpEjcYgXkE2YEFXV1JHnsKgbLWNlhScqb2UmyRkQyytRLtL+38TGxkxCflmO+5Z8CSSNY7GidjMIZ7Q4zMjA2n1nGrlTDkzwDCsw+wqFPGQA179cnfGWOWRVruj16z6XyvxvjJwbz0wQZ75XK5tKSb7FNyeIEs4TT4jk+S4dhPeAUC5y+bDYirYgM4GC7uEnztnZyaVWQ7B381AK4Qdrwt51ZqExKbQpTUNn+EjqoTwvqNj4kqx5QUCI0ThS/YkOxJCXmPUWZbhjpCg56i+2aB6CmK2JGhn57K5mj0MNdBXA4/WnwH6XoPWJzK5Nyu2zB3nAZp+S5hpQs+p1vN1/wsjk=
EOF
chmod 600 ~/.ssh/known_hosts
export GIT_SSH_COMMAND="ssh -i $HOME/.ssh/ci-deploy-key -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$HOME/.ssh/known_hosts"

if [ ! -d ~/relay-plugin ]; then
  ci_net_retry git clone https://github.com/No-Instructions/Relay.git ~/relay-plugin
fi
cd ~/relay-plugin
ci_net_retry git fetch origin --force --prune \
  '+refs/heads/*:refs/remotes/origin/*' \
  '+refs/tags/*:refs/tags/*'
git checkout -- .
git clean -fd
# A commit orphaned by a force-push is not reachable from any fetched head,
# so fall back to fetching the ref directly.
if ! git checkout --detach "$REF"; then
  ci_net_retry git fetch origin "$REF"
  git checkout --detach FETCH_HEAD
fi
echo "Relay product checkout:"
git show -s --format='  commit: %H%n  subject: %s'
echo "  describe: $(git describe --tags --always --long 2>/dev/null || git rev-parse --short HEAD)"

if [ ! -d ~/relay-harness ]; then
  ci_net_retry git clone git@github.com:No-Instructions/relay-harness.git ~/relay-harness
fi
cd ~/relay-harness
ci_net_retry git fetch origin --prune
git checkout -- .
git clean -fd
if ! git checkout --detach "$HARNESS_REF"; then
  ci_net_retry git fetch origin "${HARNESS_REF#origin/}"
  git checkout --detach FETCH_HEAD
fi
# The harness is private and its commit subjects can name plans, so the
# public log gets the commit only.
echo "Relay harness checkout: $(git rev-parse HEAD)"

# Install uv (no apt/sudo) and the test-harness Python deps into a venv,
# then export the interpreter so run-test-plan-suite.sh runs against it.
export PATH="$HOME/.local/bin:$PATH"
if ! command -v uv >/dev/null 2>&1; then
  echo ">>> installing uv"
  ci_net_retry sh -c 'wget -qO- https://astral.sh/uv/install.sh | sh' \
    || { echo ">>> UV INSTALL FAILED (exit $?)"; exit 1; }
fi
echo ">>> uv: $(uv --version 2>&1)"
uv venv --clear ~/.harness-venv \
  || { echo ">>> UV VENV FAILED (exit $?)"; exit 1; }
export RELAY_TEST_PLAN_PYTHON="$HOME/.harness-venv/bin/python"
ci_net_retry uv pip install --python "$RELAY_TEST_PLAN_PYTHON" \
  click websockets tree-sitter tree-sitter-javascript matplotlib \
  || { echo ">>> UV DEPS INSTALL FAILED (exit $?)"; exit 1; }
"$RELAY_TEST_PLAN_PYTHON" -c "import click, websockets, tree_sitter, tree_sitter_javascript, matplotlib" \
  || { echo ">>> PYTHON IMPORT FAILED (exit $?)"; exit 1; }
echo ">>> python deps ok; playwright npm install"
cd ~/relay-harness/playwright && ci_net_retry npm install --ignore-scripts --no-audit --no-fund --loglevel=error \
  || { echo ">>> PLAYWRIGHT NPM FAILED (exit $?)"; exit 1; }
echo ">>> playwright ok"

export RELAY_PLUGIN_DIR=~/relay-plugin
if [ -n "$PROFILE_FLAGS" ]; then
  export RELAY_PROFILE_FLAG_OVERRIDES="$PROFILE_FLAGS"
  echo ">>> profile flag overrides: $RELAY_PROFILE_FLAG_OVERRIDES"
fi
if [ -n "$SHARED_SLOTS" ]; then
  export RELAY_SHARED_SLOT_CANDIDATES="$SHARED_SLOTS"
  echo ">>> staging-user pool: shared slots $SHARED_SLOTS"
fi
if [ -n "$FREE_SLOTS" ]; then
  export RELAY_FREE_SLOT_CANDIDATES="$FREE_SLOTS"
  echo ">>> staging-user pool: free slots $FREE_SLOTS"
fi
cd ~/relay-harness

TEST_EXIT=0
TEST_LOG="$HOME/test-plan-suite-output.txt"
RELAY_RUN_EXEC_SUFFIX="$EXEC_SUFFIX" \
  bash ./scripts/run-test-plan-suite.sh --upload --force-slots "--tests=$SELECTED_TESTS" >"$TEST_LOG" 2>&1 || TEST_EXIT=$?
echo "Scripted test-plan runner exited with status $TEST_EXIT"

LATEST_SUMMARY=$(find /tmp/test-reports/runs -mindepth 3 -maxdepth 3 -type f -name summary.json -print0 2>/dev/null \
  | xargs -0 -r ls -t 2>/dev/null \
  | head -1)
if [ -z "$LATEST_SUMMARY" ]; then
  echo '{"summary":{"total":0,"pass":0,"fail":0},"tests":[],"state":"error"}' > ~/test-summary.json
  echo '{"reportUrl":"","commit":"","execId":""}' > ~/test-metadata.json
  exit "$TEST_EXIT"
fi

LATEST="$(dirname "$LATEST_SUMMARY")"
COMMIT=$(basename "$(dirname "$LATEST")")
EXEC_ID=$(basename "$LATEST")
REPORT_URL="https://ci.system3.dev/runs/${COMMIT}/${EXEC_ID}/index.html"
# The suite already published its report; this adds the suite log to it. A
# failed upload leaves the verdict alone: it says nothing about the product.
cp "$TEST_LOG" "$LATEST/suite-output.txt"
if ! ci_net_retry node scripts/upload-report.mjs "$LATEST" "$COMMIT" "$EXEC_ID" \
  > "$HOME/final-report-upload.log" 2>&1; then
  echo "::warning::Could not add the suite log to the report"
fi
echo "{\"reportUrl\": \"$REPORT_URL\", \"commit\": \"$COMMIT\", \"execId\": \"$EXEC_ID\"}" > ~/test-metadata.json

node - "$LATEST_SUMMARY" > ~/test-summary.json <<'NODE'
const fs = require('fs');
const [summaryPath] = process.argv.slice(2);
const raw = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));

const planIdFor = test => {
  const source = `${test?.dir || ''} ${test?.name || ''}`.toLowerCase();
  const match = source.match(/\btp[-_ ]?(\d{3})\b/);
  return match ? `tp${match[1]}` : 'tp???';
};

const tests = (raw.tests || []).map(test => ({
  name: planIdFor(test),
  dir: planIdFor(test),
  status: test.status || (test.passed ? 'pass' : 'fail'),
  passed: test.passed === true || test.status === 'pass',
}));

const counts = tests.reduce((acc, test) => {
  acc[test.status] = (acc[test.status] || 0) + 1;
  return acc;
}, {});
const rawSummary = raw.summary || {};
const summary = {
  total: rawSummary.total ?? tests.length,
  pass: rawSummary.pass ?? counts.pass ?? 0,
  fail: rawSummary.fail ?? counts.fail ?? 0,
  expectedFail: rawSummary.expectedFail ?? counts.expected_fail ?? 0,
  unexpectedPass: rawSummary.unexpectedPass ?? counts.unexpected_pass ?? 0,
  duration: rawSummary.duration ?? 0,
};

process.stdout.write(JSON.stringify({
  state: raw.state || (summary.fail > 0 ? 'failure' : 'success'),
  summary,
  tests,
}, null, 2));
NODE

exit "$TEST_EXIT"
