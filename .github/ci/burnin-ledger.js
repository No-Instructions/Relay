// Appends one burn-in run's per-plan verdicts to the persistent ledger.
//
//   node burnin-ledger.js RESULTS_DIR LEDGER_FILE
//
// RESULTS_DIR holds one burnin-<plan>/ directory per leg with summary.json
// and metadata.json, and expected-red.json from the prepare job. Each leg
// becomes one ledger row: pass, fail, or infra (the plan never ran).
// Environment: GITHUB_RUN_ID, PRODUCT_SHA, SOAK_REF.
const fs = require('fs');
const path = require('path');

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// Plans whose red has an open, known cause, keyed by plan id: their fails are
// recorded as expected rather than counted as flakes. The suite manifest's
// burnInExpectedRed fields supply them.
function expectedRed(resultsDir) {
  const map = readJson(path.join(resultsDir, 'expected-red.json'), {});
  return map && typeof map === 'object' && !Array.isArray(map) ? map : {};
}

function rowsFor(resultsDir, { runId, sha, ref, now = new Date() }) {
  const nightIso = now.toISOString();
  const expected = expectedRed(resultsDir);
  const dirs = fs.existsSync(resultsDir)
    ? fs.readdirSync(resultsDir).filter(d => d.startsWith('burnin-'))
    : [];
  return dirs.map(d => {
    const plan = d.replace(/^burnin-/, '');
    const summary = readJson(path.join(resultsDir, d, 'summary.json'), { state: 'error', summary: {}, tests: [] });
    const meta = readJson(path.join(resultsDir, d, 'metadata.json'), { reportUrl: '' });
    const s = summary.summary || {};
    const executed = (s.total || 0) > 0 && summary.state !== 'error';
    const status = !executed ? 'infra' : (s.fail || 0) > 0 ? 'fail' : 'pass';
    return {
      night: nightIso.slice(0, 10),
      ts: nightIso,
      runId,
      sha: (sha || '').slice(0, 12),
      ref: ref || '',
      plan,
      status,
      durationMs: s.duration || 0,
      expected: typeof expected[plan] === 'string' ? expected[plan] : null,
      reportUrl: meta.reportUrl || '',
    };
  }).sort((a, b) => a.plan.localeCompare(b.plan));
}

function main([resultsDir, ledgerFile]) {
  const rows = rowsFor(resultsDir, {
    runId: String(process.env.GITHUB_RUN_ID || ''),
    sha: process.env.PRODUCT_SHA,
    ref: process.env.SOAK_REF,
  });
  const existing = fs.readFileSync(ledgerFile, 'utf8').split('\n').filter(line => line.trim());
  const kept = existing.map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  if (kept.length !== existing.length) {
    console.error(`Dropped ${existing.length - kept.length} unparseable ledger lines`);
  }
  const all = kept.concat(rows);
  fs.writeFileSync(ledgerFile, all.map(r => JSON.stringify(r)).join('\n') + '\n');
  for (const r of rows) console.log(`${r.plan}\t${r.status}`);
}

if (require.main === module) main(process.argv.slice(2));
module.exports = { rowsFor };
