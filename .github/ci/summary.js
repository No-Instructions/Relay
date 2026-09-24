// Renders an E2E job's summary.json and metadata.json as the job summary,
// points the job's check at the private report, and sets the job verdict.
//
// Called from actions/github-script:
//   await require(`${process.env.GITHUB_WORKSPACE}/.github/ci/summary.js`)(
//     { github, context, core }, { title: `E2E burn-in (${plan})`, checkName: `burnin (${plan})` });
//
// The summary shows each test's opaque id and status (see public-summary.js).
//
// The repository is public, so the summary carries plan ids and verdicts
// only; everything else stays in the private report.
const fs = require('fs');
const path = require('path');

const STATUS_EMOJI = {
  pass: ':white_check_mark:',
  fail: ':x:',
  expected_fail: ':warning:',
  unexpected_pass: ':sparkles:',
};

function planIdFor(test) {
  const source = `${test?.dir || ''} ${test?.name || ''}`.toLowerCase();
  const match = source.match(/\btp[-_ ]?(\d{3})\b/);
  return match ? `tp${match[1]}` : 'tp???';
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

// Returns the job summary markdown and the verdict: null for a pass, or the
// failure message.
function render(title, summary, metadata, { table = true } = {}) {
  if (!summary) {
    return { md: `## ${title}\n\n:x: **Failed to retrieve test results from VM**\n`, failure: 'No test results available' };
  }
  const s = summary.summary || {};
  const failed = (s.fail || 0) > 0;
  const ran = (s.total || 0) > 0 && summary.state !== 'error';
  if (!ran) {
    let md = `## ${title}\n\n:grey_question: **NO TESTS RAN** (infrastructure)`;
    if (metadata.reportUrl) md += ` | [Private Report](${metadata.reportUrl})`;
    return { md: `${md}\n`, failure: 'No tests were executed' };
  }
  const parts = [];
  if (s.pass) parts.push(`${s.pass} pass`);
  if (s.fail) parts.push(`${s.fail} fail`);
  if (s.expectedFail) parts.push(`${s.expectedFail} expected-fail`);
  if (s.unexpectedPass) parts.push(`${s.unexpectedPass} unexpected-pass`);

  let md = `## ${title}\n\n`;
  md += `${failed ? ':x:' : ':white_check_mark:'} **${failed ? 'FAIL' : 'PASS'}** | ${parts.join(', ')} | ${Math.round((s.duration || 0) / 1000)}s`;
  if (metadata.reportUrl) md += ` | [Private Report](${metadata.reportUrl})`;
  md += '\n';
  if (table) {
    md += '\n| Test | Status |\n|------|--------|\n';
    for (const t of summary.tests || []) {
      md += `| ${planIdFor(t)} | ${STATUS_EMOJI[t.status] || ':grey_question:'} ${t.status} |\n`;
    }
  }

  return { md, failure: failed ? `${s.fail} test(s) failed` : null };
}

async function pointCheckAtReport({ github, context, core }, checkName, reportUrl) {
  try {
    const { owner, repo } = context.repo;
    const { data } = await github.rest.checks.listForRef({
      owner, repo, ref: context.sha, check_name: checkName, per_page: 100,
    });
    const runPath = `/actions/runs/${context.runId}/`;
    const check = data.check_runs.find(run => (run.details_url || '').includes(runPath)) || data.check_runs[0];
    if (check) {
      await github.rest.checks.update({ owner, repo, check_run_id: check.id, details_url: reportUrl });
    }
  } catch (error) {
    core.warning(`Failed to update check details URL: ${error.message}`);
  }
}

// Options: title, checkName (the check to point at the report), table
// (false renders counts only), dir (where summary.json and metadata.json are).
module.exports = async function summarize(api, { title, checkName, table = true, dir = '.' }) {
  const summary = readJson(path.join(dir, 'summary.json'));
  const metadata = readJson(path.join(dir, 'metadata.json')) || { reportUrl: '', commit: '', execId: '' };
  const { md, failure } = render(title, summary, metadata, { table });
  api.core.summary.addRaw(md);
  await api.core.summary.write();
  if (summary && metadata.reportUrl && checkName) {
    await pointCheckAtReport(api, checkName, metadata.reportUrl);
  }
  if (failure) api.core.setFailed(failure);
};
module.exports.render = render;
