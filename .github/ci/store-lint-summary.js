// Renders store-lint results as the job summary and applies the severity
// policy: error-severity findings fail the job; warnings are inventory only.
//
// Called from actions/github-script:
//   await require(`${process.env.GITHUB_WORKSPACE}/.github/ci/store-lint-summary.js`)(
//     { core }, { results: `${process.env.RUNNER_TEMP}/store-lint/results.json` });
const fs = require('fs');

const ruleOf = m => m.ruleId
  || (/^Unused eslint-disable/.test(m.message) ? 'unused-disable-directive' : 'core');

module.exports = async function summarize({ core }, { results: resultsFile, root = process.env.GITHUB_WORKSPACE || process.cwd() }) {
  let results;
  try {
    results = JSON.parse(fs.readFileSync(resultsFile, 'utf-8'));
  } catch {
    core.summary.addRaw('## Store lint results\n\n:x: **No lint results produced**\n');
    await core.summary.write();
    core.setFailed('No store lint results available');
    return;
  }

  const byRule = new Map();
  let errors = 0;
  let warnings = 0;
  for (const file of results) {
    errors += file.errorCount;
    warnings += file.warningCount;
    const rel = file.filePath.replace(`${root}/`, '');
    for (const m of file.messages) {
      const key = `${m.severity}:${ruleOf(m)}`;
      if (!byRule.has(key)) {
        byRule.set(key, { rule: ruleOf(m), severity: m.severity, count: 0, sample: `${rel}:${m.line}` });
      }
      byRule.get(key).count += 1;
    }
  }

  const verdict = errors > 0 ? ':x: **FAIL**' : ':white_check_mark: **PASS**';
  let md = '## Store lint results\n\n';
  md += `${verdict} | ${errors} errors, ${warnings} warnings | ${results.length} files | errors fail the job, warnings do not\n\n`;
  if (byRule.size) {
    md += '| Rule | Severity | Count | Sample |\n|---|---|---:|---|\n';
    const rows = [...byRule.values()].sort((a, b) => (b.severity - a.severity) || (b.count - a.count));
    for (const row of rows) {
      md += `| \`${row.rule}\` | ${row.severity === 2 ? 'error' : 'warning'} | ${row.count} | \`${row.sample}\` |\n`;
    }
  }
  core.summary.addRaw(md);
  await core.summary.write();

  if (results.length === 0) {
    core.setFailed('Store lint matched no files');
  } else if (errors > 0) {
    core.setFailed(`${errors} error-severity store lint finding(s)`);
  }
};
