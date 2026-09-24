// Reduces a job's results to what may be published: counts, and for each plan
// its opaque id, status, and duration; and the private report's location.
// The repository and its Actions logs and artifacts are public, and test
// content (plan names, assertions, output) must never reach them, whatever a
// harness writes into its results.
//
//   node public-summary.js SUMMARY_JSON [METADATA_JSON]  rewrites them in place;
//                                                      `-` skips one
const fs = require('fs');

const STATUSES = new Set(['pass', 'fail', 'skip', 'expected_fail', 'unexpected_pass', 'error']);
const count = value => (Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0);

// Test-plan ids (tpNNN) and unit-test ordinals (unit-NNNN) are opaque.
function planId(test) {
  const dir = String(test?.dir || '');
  if (/^unit-\d{4,5}$/.test(dir)) return dir;
  const source = `${dir} ${test?.name || ''}`.toLowerCase();
  const match = source.match(/\btp[-_ ]?(\d{3})\b/);
  return match ? `tp${match[1]}` : 'tp???';
}

function publicSummary(raw) {
  const s = raw?.summary || {};
  const tests = (Array.isArray(raw?.tests) ? raw.tests : []).map(test => {
    const status = STATUSES.has(test?.status) ? test.status : (test?.passed ? 'pass' : 'fail');
    const id = planId(test);
    const durationMs = count(test?.durationMs ?? test?.duration);
    return { name: id, dir: id, status, passed: status === 'pass', durationMs };
  });
  return {
    state: ['success', 'failure', 'error'].includes(raw?.state) ? raw.state : 'error',
    summary: {
      total: count(s.total), pass: count(s.pass), fail: count(s.fail),
      expectedFail: count(s.expectedFail), unexpectedPass: count(s.unexpectedPass),
      duration: count(s.duration),
    },
    tests,
  };
}

function publicMetadata(raw) {
  const text = value => (typeof value === 'string' ? value : '');
  const reportUrl = text(raw?.reportUrl);
  return {
    reportUrl: reportUrl.startsWith('https://ci.system3.dev/') ? reportUrl : '',
    commit: /^[0-9a-f]{7,40}$/.test(text(raw?.commit)) ? raw.commit : '',
    execId: /^[\w.-]{1,120}$/.test(text(raw?.execId)) ? raw.execId : '',
  };
}

function rewrite(file, reduce) {
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  fs.writeFileSync(file, JSON.stringify(reduce(raw), null, 2) + '\n');
}

if (require.main === module) {
  const [summaryFile, metadataFile] = process.argv.slice(2);
  if (summaryFile && summaryFile !== '-') rewrite(summaryFile, publicSummary);
  if (metadataFile && metadataFile !== '-') rewrite(metadataFile, publicMetadata);
}
module.exports = { publicSummary, publicMetadata };
