# Runs the private (git-crypt encrypted) unit tests on the unit-test VM and
# publishes their report to the private report store. lane.sh uploads this
# file with ci_vm_run, which supplies the positional parameters and
# ci_net_retry; lane.sh provisions the git-crypt key.
#
# Options: --ref REF [--harness-ref REF]; other lane options are ignored.
#
# Output: ~/test-summary.json (counts and opaque per-test ids only; test names,
# suite paths and failure messages stay in the private report) and
# ~/test-metadata.json. The exit status is Jest's.
set -eo pipefail

REF="" HARNESS_REF="origin/main"
while [ $# -gt 0 ]; do
  case "$1" in
    --ref) REF="$2" ;;
    --harness-ref) HARNESS_REF="${2:-origin/main}" ;;
    --tests|--exec-suffix|--shared-slots|--free-slots|--profile-flags|--obsidian-version|--obsidian-url) ;;
    *) echo "::error::remote-unit.sh: unknown option $1"; exit 2 ;;
  esac
  shift 2
done
[ -n "$REF" ] || { echo "::error::remote-unit.sh: --ref is required"; exit 2; }

[ -f ~/.config/relay-e2e/r2-env.sh ] && source ~/.config/relay-e2e/r2-env.sh
rm -rf /tmp/test-reports
rm -f ~/test-summary.json ~/test-metadata.json

if ! command -v git-crypt >/dev/null 2>&1; then
  ci_net_retry sudo apt-get update -qq
  ci_net_retry sudo apt-get install -y -qq git-crypt
fi

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
  '+refs/tags/0.8.0*:refs/tags/0.8.0*'
git checkout -- .
git clean -fd
# A commit orphaned by a force-push is not reachable from any
# fetched head, so fall back to fetching the ref directly.
if ! git checkout --detach "$REF"; then
  ci_net_retry git fetch origin "$REF"
  git checkout --detach FETCH_HEAD
fi
git crypt unlock ~/.config/relay-e2e/relay-git-crypt-key
if ! grep -q "describe\\|test\\|it(" __tests__/TestMinimark.ts; then
  echo "git-crypt unlock did not expose the private unit tests"
  exit 1
fi

COMMIT=$(git rev-parse --short HEAD)
EXEC_ID="unit-$(date -u +%Y%m%dT%H%M%SZ)"
REPORT_DIR="/tmp/test-reports/runs/$COMMIT/$EXEC_ID"
mkdir -p "$REPORT_DIR"
JEST_JSON="$REPORT_DIR/jest-results.json"
JEST_LOG="$REPORT_DIR/jest-output.txt"

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
git checkout --detach "$HARNESS_REF" 2>/dev/null \
  || git checkout --detach "origin/${HARNESS_REF#origin/}"

cd ~/relay-plugin
ci_net_retry npm ci

TEST_EXIT=0
npm test -- --silent --json --outputFile="$JEST_JSON" >"$JEST_LOG" 2>&1 || TEST_EXIT=$?

node - "$JEST_JSON" "$JEST_LOG" "$REPORT_DIR" "$COMMIT" "$EXEC_ID" <<'NODE'
const fs = require('fs');
const path = require('path');

const [jestJsonPath, jestLogPath, reportDir, commit, execId] = process.argv.slice(2);
const raw = JSON.parse(fs.readFileSync(jestJsonPath, 'utf8'));

const escapeHtml = value => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');
const safeSegment = value => String(value ?? '')
  .replace(/[^a-zA-Z0-9._-]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 40);
const statusFor = status => {
  if (status === 'passed') return 'pass';
  if (status === 'pending' || status === 'todo' || status === 'skipped') return 'expected_fail';
  return 'fail';
};

const started = Number(raw.startTime || Date.now());
const ended = Number(raw.endTime || Date.now());
const tests = [];
let index = 0;

for (const suite of raw.testResults || []) {
  const suiteName = path.relative(process.cwd(), suite.name || '');
  for (const assertion of suite.assertionResults || []) {
    index += 1;
    const name = [...(assertion.ancestorTitles || []), assertion.title]
      .filter(Boolean)
      .join(' > ');
    const status = statusFor(assertion.status);
    const dir = `unit-${String(index).padStart(4, '0')}`;
    const failureMessages = assertion.failureMessages || [];
    const duration = Number(assertion.duration || 0);
    const test = {
      name: name || suiteName || `unit ${index}`,
      status,
      assertions: 1,
      passedAssertions: status === 'pass' ? 1 : 0,
      duration,
      dir,
      suite: suiteName,
      firstError: failureMessages[0] || '',
    };
    tests.push(test);

    fs.mkdirSync(path.join(reportDir, dir), { recursive: true });
    const passed = status === 'pass';
    fs.writeFileSync(path.join(reportDir, dir, 'results.json'), JSON.stringify({
      testName: test.name,
      passed,
      status,
      startTime: started,
      endTime: started + duration,
      duration,
      steps: [
        {
          name: 'Jest assertion',
          passed,
          error: failureMessages.join('\n\n'),
          assertions: [
            {
              description: test.name,
              expected: 'pass',
              actual: status,
              passed,
            },
          ],
          actions: [],
          trace: [],
        },
      ],
      summary: {
        totalSteps: 1,
        passedSteps: passed ? 1 : 0,
        totalAssertions: 1,
        passedAssertions: passed ? 1 : 0,
        totalActions: 0,
      },
    }, null, 2));
    fs.writeFileSync(path.join(reportDir, dir, 'index.html'), `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(test.name)}</title>
  <style>
    body { color: #e6e6e6; background: #181818; font: 14px/1.5 system-ui, sans-serif; margin: 32px; }
    a { color: #8ab4ff; }
    pre { background: #111; border: 1px solid #333; border-radius: 6px; padding: 16px; overflow: auto; }
    .status { font-weight: 700; text-transform: uppercase; }
    .pass { color: #7ee787; }
    .fail { color: #ff7b72; }
    .expected_fail { color: #d29922; }
  </style>
</head>
<body>
  <p><a href="../index.html">Back to unit report</a></p>
  <h1>${escapeHtml(test.name)}</h1>
  <p class="status ${escapeHtml(status)}">${escapeHtml(status)}</p>
  <p><strong>Suite:</strong> ${escapeHtml(suiteName)}</p>
  <p><strong>Duration:</strong> ${escapeHtml(duration)}ms</p>
  ${failureMessages.length ? `<h2>Failure</h2><pre>${escapeHtml(failureMessages.join('\n\n'))}</pre>` : ''}
</body>
</html>
`);
  }
}

const counts = tests.reduce((acc, test) => {
  acc[test.status] = (acc[test.status] || 0) + 1;
  return acc;
}, {});
const summary = {
  summary: {
    total: tests.length,
    pass: counts.pass || 0,
    fail: counts.fail || 0,
    expectedFail: counts.expected_fail || 0,
    unexpectedPass: 0,
    duration: Math.max(0, ended - started),
  },
  tests,
  state: (counts.fail || 0) > 0 ? 'failure' : 'success',
};

fs.writeFileSync(path.join(reportDir, 'summary.json'), JSON.stringify(summary, null, 2));

const rows = tests.map(test => `
  <tr class="${escapeHtml(test.status)}">
    <td><a href="${escapeHtml(test.dir)}/index.html">${escapeHtml(test.name)}</a></td>
    <td>${escapeHtml(test.status)}</td>
    <td>${escapeHtml(test.suite)}</td>
    <td>${escapeHtml(test.duration)}ms</td>
  </tr>
`).join('');
fs.writeFileSync(path.join(reportDir, 'index.html'), `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Relay Unit Tests ${escapeHtml(commit)}</title>
  <style>
    body { color: #e6e6e6; background: #181818; font: 14px/1.5 system-ui, sans-serif; margin: 32px; }
    a { color: #8ab4ff; }
    table { width: 100%; border-collapse: collapse; }
    th, td { border-bottom: 1px solid #333; padding: 8px; text-align: left; vertical-align: top; }
    tr.pass td:nth-child(2) { color: #7ee787; }
    tr.fail td:nth-child(2) { color: #ff7b72; }
    tr.expected_fail td:nth-child(2) { color: #d29922; }
    .summary { display: flex; gap: 16px; margin: 16px 0 24px; }
    .summary span { background: #222; border: 1px solid #333; border-radius: 6px; padding: 8px 10px; }
  </style>
</head>
<body>
  <h1>Relay Unit Tests</h1>
  <p>Commit ${escapeHtml(commit)} / ${escapeHtml(execId)}</p>
  <div class="summary">
    <span>${summary.summary.pass} pass</span>
    <span>${summary.summary.fail} fail</span>
    <span>${summary.summary.expectedFail} expected fail</span>
    <span>${summary.summary.total} total</span>
  </div>
  <p><a href="jest-results.json">Jest JSON</a> | <a href="jest-output.txt">Jest output</a> | <a href="summary.json">Summary JSON</a></p>
  <table>
    <thead><tr><th>Test</th><th>Status</th><th>Suite</th><th>Duration</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</body>
</html>
`);

if (!fs.existsSync(jestLogPath)) {
  fs.writeFileSync(jestLogPath, '');
}
NODE

# A failed upload leaves the verdict alone: it says nothing about the product.
REPORT_URL="https://ci.system3.dev/runs/${COMMIT}/${EXEC_ID}/index.html"
if ! ci_net_retry node ~/relay-harness/scripts/upload-report.mjs "$REPORT_DIR" "$COMMIT" "$EXEC_ID" >"$REPORT_DIR/upload-output.txt" 2>&1; then
  echo "::warning::Could not publish the unit-test report"
  REPORT_URL=""
fi

# The public artifact gets counts + per-test {dir,status,duration} only;
# test names, suite paths, and failure messages stay in the private R2
# report (already uploaded above), never a public artifact.
node -e 'const fs=require("fs");const s=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));fs.writeFileSync(process.argv[2],JSON.stringify({summary:s.summary,state:s.state,tests:(s.tests||[]).map(t=>({dir:t.dir,status:t.status,duration:t.duration}))},null,2));' "$REPORT_DIR/summary.json" ~/test-summary.json
echo "{\"reportUrl\":\"$REPORT_URL\",\"commit\":\"$COMMIT\",\"execId\":\"$EXEC_ID\"}" > ~/test-metadata.json

exit $TEST_EXIT
